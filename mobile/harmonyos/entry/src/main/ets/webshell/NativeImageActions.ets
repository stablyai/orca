import { util } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';
import { fileIo as fs, fileUri } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { systemShare } from '@kit.ShareKit';
import { http } from '@kit.NetworkKit';
import { base64Decode, base64Encode } from '../transport/crypto/Bytes';

const IMAGE_LIMIT = 18 * 1024 * 1024;
const CHUNK_LIMIT = 512 * 1024;
const MIMES: string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif', 'image/heic', 'image/heif'];

export class NativeImageActions {
  private context: common.UIAbilityContext;
  private staged = new Uint8Array(0);
  private generation = 0;
  private documentId: string = util.generateRandomUUID();
  private closed = false;
  private running = false;
  private sequence = 0;
  private exportDirectory = '';
  private download: http.HttpRequest | null = null;
  private isActive: () => boolean;

  constructor(context: common.UIAbilityContext, isActive: () => boolean = (): boolean => true) {
    this.context = context; this.isActive = isActive;
  }

  private assertLive(generation: number): void {
    if (this.closed || generation !== this.generation || !this.isActive()) { throw new Error('Image page closed'); }
  }

  async serve(value: ESObject): Promise<ESObject> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid image parameters'); }
    this.assertLive(this.generation);
    if (value['action'] === 'stage') {
      if (this.running || Object.keys(value).length !== 3 || typeof value['base64'] !== 'string'
        || value['base64'].length < 1 || value['base64'].length > CHUNK_LIMIT
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value['base64'])
        || !Number.isInteger(value['offset']) || value['offset'] < 0) { throw new Error('Invalid image chunk'); }
      let bytes = base64Decode(value['base64']);
      if (base64Encode(bytes) !== value['base64']) { throw new Error('Invalid image base64'); }
      if (value['offset'] === 0) { this.staged = new Uint8Array(0); }
      if (this.staged.length !== value['offset'] || this.staged.length + bytes.length > IMAGE_LIMIT) {
        this.staged = new Uint8Array(0); throw new Error('Invalid staged image range');
      }
      let next = new Uint8Array(this.staged.length + bytes.length); next.set(this.staged); next.set(bytes, this.staged.length);
      this.staged = next; return {};
    }
    if (value['action'] !== 'run' || Object.keys(value).length !== 3 || !['copy', 'save', 'share'].includes(value['operation'])
      || this.running) { throw new Error('Invalid image operation'); }
    this.running = true; let generation = this.generation;
    try {
      let source: ESObject = value['source']; let bytes: Uint8Array; let mime = '';
      if (source === null || typeof source !== 'object' || Array.isArray(source)) { throw new Error('Invalid image source'); }
      if (source['kind'] === 'staged' && Object.keys(source).length === 3 && MIMES.includes(source['mime'])
        && Number.isInteger(source['byteLength']) && source['byteLength'] > 0 && source['byteLength'] === this.staged.length) {
        bytes = this.staged; this.staged = new Uint8Array(0); mime = source['mime'];
      } else if (source['kind'] === 'url' && Object.keys(source).length === 2 && typeof source['url'] === 'string'
        && /^https:\/\/[^\s/@?#]+(?:[/?#]|$)/i.test(source['url']) && source['url'].length <= 8192) {
        let request = http.createHttp(); this.download = request;
        try {
          let response = await request.request(source['url'], { expectDataType: http.HttpDataType.ARRAY_BUFFER,
            connectTimeout: 10000, readTimeout: 15000, maxLimit: IMAGE_LIMIT });
          if (response.responseCode !== 200 || !(response.result instanceof ArrayBuffer)) { throw new Error('Image download failed'); }
          bytes = new Uint8Array(response.result);
          let headers: ESObject = response.header;
          mime = String(headers['content-type'] ?? headers['Content-Type'] ?? '').split(';')[0].toLowerCase();
          if (!MIMES.includes(mime)) { throw new Error('Unsupported image type'); }
        } finally { request.destroy(); this.download = null; }
      } else { throw new Error('Invalid image source'); }
      this.assertLive(generation);
      if (bytes.length === 0 || bytes.length > IMAGE_LIMIT) { throw new Error('Image too large or empty'); }
      let imageSource = image.createImageSource(bytes.buffer as ArrayBuffer);
      let pixel: image.PixelMap | null = null;
      try {
        let info = await imageSource.getImageInfo();
        if (info.size.width * info.size.height > 40000000) { throw new Error('Image dimensions too large'); }
        this.assertLive(generation);
        if (value['operation'] === 'copy') {
          pixel = await imageSource.createPixelMap(); this.assertLive(generation);
          await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_PIXELMAP, pixel));
        } else {
          this.clearExportDirectory(); this.sequence++;
          let extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
          let directory = `${this.context.cacheDir}/orca-image-${this.documentId}-${this.sequence}`;
          fs.mkdirSync(directory);
          this.exportDirectory = directory;
          let path = `${directory}/image.${extension}`;
          try {
            let file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.READ_WRITE);
            try {
              if (fs.writeSync(file.fd, bytes.buffer) !== bytes.length) { throw new Error('Image write failed'); }
            } finally { fs.closeSync(file); }
          } catch (e) {
            this.clearExportDirectory();
            throw new Error((e as Error).message);
          }
          let uri = fileUri.getUriFromPath(path);
          this.assertLive(generation);
          if (value['operation'] === 'save') {
            let helper = photoAccessHelper.getPhotoAccessHelper(this.context);
            try {
              let destinations = await helper.showAssetsCreationDialog([uri], [{ title: 'Orca image', fileNameExtension: extension,
                photoType: photoAccessHelper.PhotoType.IMAGE }]);
              this.assertLive(generation);
              if (destinations.length !== 1) { throw new Error('Image save cancelled'); }
              let destination = await fs.open(destinations[0], fs.OpenMode.WRITE_ONLY);
              try {
                if (await fs.write(destination.fd, bytes.buffer) !== bytes.length) { throw new Error('Image save failed'); }
              } finally { await fs.close(destination); }
            } finally { await helper.release(); }
          } else {
            let share = new systemShare.ShareController(new systemShare.SharedData({ utd: mime === 'image/png' ? 'general.png'
              : mime === 'image/jpeg' ? 'general.jpeg' : 'general.image', uri: uri }));
            await share.show(this.context, {});
          }
        }
      } finally { if (pixel) { await pixel.release(); } imageSource.release(); }
      return {};
    } finally { this.running = false; }
  }

  private clearExportDirectory(): void {
    if (!this.exportDirectory) { return; }
    try { fs.rmdirSync(this.exportDirectory); } catch (e) { }
    this.exportDirectory = '';
  }

  pause(): void { this.generation++; this.staged = new Uint8Array(0); try { this.download?.destroy(); } catch (e) { } this.download = null; }
  dispose(): void { this.closed = true; this.pause(); this.clearExportDirectory(); }
}
