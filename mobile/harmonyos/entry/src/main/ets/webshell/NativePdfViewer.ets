import { util } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';
import { fileIo as fs, fileUri } from '@kit.CoreFileKit';
import { pdfService, pdfViewManager } from '@kit.PDFKit';
import { filePreview } from '@kit.PreviewKit';
import { SpikeRpcClient, RpcSuccess } from '../transport/SpikeRpcClient';
import { base64Decode } from '../transport/crypto/Bytes';

const PDF_LIMIT = 256 * 1024 * 1024;
const CHUNK_BYTES = 384 * 1024;

export interface PdfPreview {
  title: string;
  path: string;
  controller: pdfViewManager.PdfController | null;
  unlock: ((password: string) => Promise<pdfViewManager.PdfController | null>) | null;
}

export class NativePdfViewer {
  private context: common.UIAbilityContext;
  private client: SpikeRpcClient | null;
  private onPreview: (preview: PdfPreview | null) => void;
  private generation = 0;
  private documentId: string = util.generateRandomUUID();
  private counter = 0;
  private requests: Set<string> = new Set();
  private path = '';
  private controller: pdfViewManager.PdfController | null = null;
  private inApp = false;
  private external = false;
  private presentation: Promise<void> = Promise.resolve();
  private disposed = false;
  private isActive: () => boolean;

  constructor(context: common.UIAbilityContext, client: SpikeRpcClient | null, onPreview: (preview: PdfPreview | null) => void,
    isActive: () => boolean = (): boolean => true) {
    this.context = context; this.client = client; this.onPreview = onPreview; this.isActive = isActive;
  }

  setClient(client: SpikeRpcClient | null): void {
    if (this.client === client) { return; }
    if (!this.inApp) { this.pause().catch(() => {}); }
    this.client = client;
  }

  private active(generation: number): void {
    if (this.disposed || generation !== this.generation) { throw new Error('PDF open cancelled'); }
  }

  private async request(method: string, params: ESObject, executionHost: string | undefined): Promise<ESObject> {
    if (!this.client) { throw new Error('No desktop connection'); }
    this.counter++; let id = `pdf-${this.documentId}-${this.counter}`;
    let wire: ESObject = JSON.parse(this.client.buildWire(id, method, JSON.stringify(params)));
    if (executionHost) { wire['executionHost'] = executionHost; }
    this.requests.add(id);
    try {
      let response = await this.client.requestRaw(id, JSON.stringify(wire), 30000);
      if (!(response instanceof RpcSuccess)) { throw new Error(response.errorMessage); }
      return JSON.parse(response.result);
    } finally { this.requests.delete(id); }
  }

  async serve(value: ESObject): Promise<ESObject> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid PDF parameters'); }
    if (value['action'] === 'cancel' && Object.keys(value).length === 1) { await this.cancel(); return {}; }
    let executionHost: string | undefined = value['executionHost'];
    if (value['action'] !== 'open' || !Object.keys(value).every((key: string): boolean => ['action', 'worktreeId', 'relativePath', 'executionHost'].includes(key))
      || typeof value['worktreeId'] !== 'string' || value['worktreeId'].length < 1
      || typeof value['relativePath'] !== 'string' || !/\.pdf$/i.test(value['relativePath'])
      || (executionHost !== undefined && (typeof executionHost !== 'string' || !/^runtime:.+/.test(executionHost)))) {
      throw new Error('Invalid PDF parameters');
    }
    if (!this.isActive()) { throw new Error('PDF page is not active'); }
    let generation = this.generation + 1; await this.cancel(); this.active(generation);
    let params: ESObject = { worktree: `id:${value['worktreeId']}`, relativePath: value['relativePath'] };
    let stat: ESObject = await this.request('files.stat', params, executionHost); this.active(generation);
    if (stat.isDirectory !== false || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > PDF_LIMIT
      || !Number.isFinite(stat.mtime)) { throw new Error('PDF is empty, too large or unavailable'); }
    this.counter++; let path = `${this.context.cacheDir}/orca-preview-${this.documentId}-${this.counter}.pdf`;
    let file = await fs.open(path, fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.READ_WRITE);
    let ready = false;
    try {
      let offset = 0;
      while (offset < stat.size) {
        this.active(generation);
        let length = Math.min(CHUNK_BYTES, stat.size - offset);
        let chunkParams: ESObject = { worktree: params.worktree, relativePath: params.relativePath, offset: offset, length: length };
        let chunk: ESObject = await this.request('files.readChunk', chunkParams, executionHost); this.active(generation);
        if (typeof chunk.contentBase64 !== 'string' || chunk.contentBase64.length > 524288
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.contentBase64)) { throw new Error('Invalid PDF chunk'); }
        let bytes = base64Decode(chunk.contentBase64);
        if (bytes.length === 0 || bytes.length !== chunk.bytesRead || bytes.length > length
          || typeof chunk.eof !== 'boolean' || (chunk.eof && offset + bytes.length !== stat.size)) { throw new Error('PDF changed during download'); }
        if (offset === 0 && (bytes[0] !== 37 || bytes[1] !== 80 || bytes[2] !== 68 || bytes[3] !== 70 || bytes[4] !== 45)) {
          throw new Error('The file is not a PDF');
        }
        let written = await fs.write(file.fd, bytes.buffer);
        if (written !== bytes.length) { throw new Error('PDF write failed'); }
        offset += bytes.length;
      }
      let latest: ESObject = await this.request('files.stat', params, executionHost); this.active(generation);
      if (latest.isDirectory !== false || latest.size !== stat.size || latest.mtime !== stat.mtime
        || (stat.ctime !== undefined && stat.ctime !== latest.ctime)) { throw new Error('PDF changed during download'); }
      ready = true;
    } finally { await fs.close(file); if (!ready) { try { await fs.unlink(path); } catch (e) { } } }
    if (this.disposed || generation !== this.generation) { try { await fs.unlink(path); } catch (e) { } this.active(generation); }
    let present = this.presentation.then(async (): Promise<void> => {
      try {
        this.active(generation); this.path = path;
        await this.present(path, value['relativePath'].split(/[\\/]/).pop() ?? 'PDF', generation);
      } catch (e) {
        if (this.path === path) { this.path = ''; this.releaseController(); }
        try { await fs.unlink(path); } catch (ignored) { }
        this.external = false;
        throw new Error((e as Error).message);
      }
      this.active(generation);
    });
    this.presentation = present.catch(() => {});
    await present;
    return {};
  }

  private async present(path: string, title: string, generation: number): Promise<void> {
    if (!this.isActive()) { throw new Error('PDF page is not active'); }
    if (canIUse('SystemCapability.OfficeService.PDFService.Core')) {
      let controller = await this.loadDocument(path, generation, ''); this.active(generation);
      if (!this.isActive()) { throw new Error('PDF page is not active'); }
      this.onPreview({ title: title, path: path, controller: controller,
        unlock: controller ? null : (password: string): Promise<pdfViewManager.PdfController | null> =>
          this.unlock(path, generation, password) });
      this.inApp = true;
      return;
    }
    this.external = true;
    await filePreview.openPreview(this.context, { uri: fileUri.getUriFromPath(path), mimeType: 'application/pdf', title: title });
  }

  private async loadDocument(path: string, generation: number, password: string): Promise<pdfViewManager.PdfController | null> {
    let controller = new pdfViewManager.PdfController();
    try {
      let result = await controller.loadDocument(path, password); this.active(generation);
      if (result === pdfService.ParseResult.PARSE_ERROR_PASSWORD) { return null; }
      if (result !== pdfService.ParseResult.PARSE_SUCCESS) { throw new Error('The PDF could not be opened'); }
      this.controller = controller;
      return controller;
    } finally {
      if (this.controller !== controller) { try { controller.releaseDocument(); } catch (e) { } }
    }
  }

  private unlock(path: string, generation: number, password: string): Promise<pdfViewManager.PdfController | null> {
    let loaded = this.presentation.then(async (): Promise<pdfViewManager.PdfController | null> => {
      this.active(generation);
      if (!this.isActive()) { throw new Error('PDF page is not active'); }
      return this.controller ?? await this.loadDocument(path, generation, password);
    });
    this.presentation = loaded.then((): void => {}, (): void => {});
    return loaded;
  }

  private releaseController(): void {
    let controller = this.controller; this.controller = null;
    if (controller) { try { controller.releaseDocument(); } catch (e) { } }
  }

  pause(): Promise<void> {
    return this.external || this.inApp ? Promise.resolve() : this.cancel();
  }

  cancel(): Promise<void> {
    this.generation++;
    this.requests.forEach((id: string): void => { this.client?.cancelById(id); }); this.requests.clear();
    if (this.inApp) { this.inApp = false; this.onPreview(null); }
    let close = this.presentation.then(async (): Promise<void> => {
      let path = this.path;
      if (!path) { return; }
      this.path = '';
      this.releaseController();
      if (this.external) {
        this.external = false;
        try { await filePreview.closePreview(this.context); } catch (e) { }
      }
      try { await fs.unlink(path); } catch (e) { }
    });
    this.presentation = close;
    return close;
  }

  async dispose(): Promise<void> { this.disposed = true; await this.cancel(); }
}
