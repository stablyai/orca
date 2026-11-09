import { util } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';
import { fileIo as fs, fileUri } from '@kit.CoreFileKit';
import { filePreview } from '@kit.PreviewKit';
import { SpikeRpcClient, RpcSuccess } from '../transport/SpikeRpcClient';
import { base64Decode } from '../transport/crypto/Bytes';

const PDF_LIMIT = 256 * 1024 * 1024;
const CHUNK_BYTES = 384 * 1024;

export class NativePdfViewer {
  private context: common.UIAbilityContext;
  private client: SpikeRpcClient | null;
  private generation = 0;
  private documentId: string = util.generateRandomUUID();
  private counter = 0;
  private requests: Set<string> = new Set();
  private path = '';
  private presentation: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(context: common.UIAbilityContext, client: SpikeRpcClient | null) { this.context = context; this.client = client; }

  setClient(client: SpikeRpcClient | null): void {
    if (this.client === client) { return; }
    this.pause().catch(() => {});
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
        await filePreview.openPreview(this.context, { uri: fileUri.getUriFromPath(path), mimeType: 'application/pdf',
          title: value['relativePath'].split(/[\\/]/).pop() ?? 'PDF' });
      } catch (e) {
        try { await fs.unlink(path); } catch (ignored) { }
        if (this.path === path) { this.path = ''; }
        throw new Error((e as Error).message);
      }
      this.active(generation);
    });
    this.presentation = present.catch(() => {});
    await present;
    return {};
  }

  pause(): Promise<void> {
    // Preview Kit itself backgrounds Orca and can still be opening the cached file.
    return this.path ? Promise.resolve() : this.cancel();
  }

  cancel(): Promise<void> {
    this.generation++;
    this.requests.forEach((id: string): void => { this.client?.cancelById(id); }); this.requests.clear();
    let close = this.presentation.then(async (): Promise<void> => {
      let path = this.path;
      if (!path) { return; }
      this.path = '';
      try { await filePreview.closePreview(this.context); } catch (e) { }
      try { await fs.unlink(path); } catch (e) { }
    });
    this.presentation = close;
    return close;
  }

  async dispose(): Promise<void> { this.disposed = true; await this.cancel(); }
}
