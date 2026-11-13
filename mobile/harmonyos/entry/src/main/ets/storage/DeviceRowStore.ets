import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { asset } from '@kit.AssetStoreKit';
import { common } from '@kit.AbilityKit';
import { base64DecodeCanonical, base64Encode, concatBytes, toHex, utf8Decode, utf8Encode } from '../transport/crypto/Bytes';
import { sha256 } from '../transport/crypto/Sha256';
import { naclRandomBytes, naclSecretbox, naclSecretboxOpen } from '../transport/NaclBinding';

interface RowResult { written?: boolean; refusal?: string; values?: Array<string | null>; deferred?: number[]; }
interface RowFile { path: string; bytes: number; modified: number; }
interface RowOp { key: string; value: string | null; }
export interface HomeWorktreeCounts { pairedAt: number; totalWorktrees: number; activeCount: number; }
const MAX_VALUE = 512 * 1024;
const READ_BUDGET = 6 * 1024 * 1024;
const PAIRING_TABLE = 'pairing';
const PAIRING_KEY = 'journal';
const HOME_TABLE = 'home';
const HOME_COUNTS_KEY = 'worktree-counts:v1';
const queues: Map<string, Promise<RowResult>> = new Map();

export class DeviceRowStore {
  private context: common.Context;
  private hostId: string;
  private key: Uint8Array | null = null;
  constructor(context: common.Context, hostId: string) {
    if (!/^[a-f0-9]{32}$/.test(hostId)) { throw new Error('Invalid host storage identity'); }
    this.context = context; this.hostId = hostId;
  }
  private root(table: string): string {
    if (table === PAIRING_TABLE) { return `${this.context.filesDir}/orca-pairing-rows/${this.hostId}`; }
    return `${this.tableRoot(table)}/${this.hostId}/${table}`;
  }
  private tableRoot(table: string): string {
    return `${table === 'draft' ? this.context.filesDir : this.context.cacheDir}/orca-rows`;
  }
  private path(table: string, key: string): string {
    return `${this.root(table)}/${toHex(sha256(utf8Encode(key)))}.row`;
  }
  private files(root: string): RowFile[] {
    if (!fs.accessSync(root)) { return []; }
    let files: RowFile[] = [];
    let entries = fs.listFileSync(root);
    for (let i = 0; i < entries.length; i++) {
      let path = `${root}/${entries[i]}`;
      let stat = fs.statSync(path);
      if (stat.isDirectory()) { files.push(...this.files(path)); }
      else { files.push({ path: path, bytes: Math.max(4096, stat.size), modified: stat.mtime }); }
    }
    return files;
  }
  private pairingKeyAlias(): Uint8Array {
    return utf8Encode(`orca.pairing.rows.key.${this.hostId}`);
  }
  private async openKey(pairing: boolean = false): Promise<Uint8Array> {
    if (!pairing && this.key) { return this.key; }
    let alias = pairing ? this.pairingKeyAlias() : utf8Encode(`orca.rows.key.${this.hostId}`);
    let query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, alias); query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    let found: Array<asset.AssetMap> = [];
    try { found = await asset.query(query); }
    catch (e) { if ((e as BusinessError).code !== asset.ErrorCode.NOT_FOUND) { throw e as Error; } }
    if (found.length > 0) {
      let key = found[0].get(asset.Tag.SECRET) as Uint8Array;
      if (!key || key.length !== 32) { throw new Error('Device store key unavailable'); }
      if (!pairing) { this.key = key; }
      return key;
    }
    let hasRows = pairing ? fs.accessSync(this.path(PAIRING_TABLE, PAIRING_KEY))
      : this.files(this.root('draft')).length > 0 || this.files(this.root('cache')).length > 0
        || fs.accessSync(this.path(HOME_TABLE, HOME_COUNTS_KEY));
    if (hasRows) {
      throw new Error('Device store key unavailable');
    }
    let key = naclRandomBytes(32);
    let secret: asset.AssetMap = new Map();
    secret.set(asset.Tag.ALIAS, alias); secret.set(asset.Tag.SECRET, key);
    await asset.add(secret);
    if (!pairing) { this.key = key; }
    return key;
  }
  async readPairingJournal(): Promise<string | null> {
    if (!fs.accessSync(this.path(PAIRING_TABLE, PAIRING_KEY))) { return null; }
    return this.readValue(PAIRING_TABLE, PAIRING_KEY, await this.openKey(true));
  }
  async writePairingJournal(value: string): Promise<void> {
    if (value.length > MAX_VALUE) { throw new Error('Pairing journal is too large'); }
    let encoded = this.encodeValue(PAIRING_TABLE, PAIRING_KEY, value, await this.openKey(true));
    if (encoded.length > MAX_VALUE * 2) { throw new Error('Pairing journal is too large'); }
    let directory = this.root(PAIRING_TABLE);
    if (!fs.accessSync(directory)) { fs.mkdirSync(directory, true); }
    this.commitValue(this.path(PAIRING_TABLE, PAIRING_KEY), encoded);
  }
  async deletePairingJournal(): Promise<void> {
    let directory = this.root(PAIRING_TABLE);
    if (fs.accessSync(directory)) { fs.rmdirSync(directory); }
    let query: asset.AssetMap = new Map(); query.set(asset.Tag.ALIAS, this.pairingKeyAlias());
    try { await asset.remove(query); }
    catch (e) { if ((e as BusinessError).code !== asset.ErrorCode.NOT_FOUND) { throw e as Error; } }
  }
  private readValue(table: string, name: string, key: Uint8Array): string | null {
    let path = this.path(table, name);
    if (!fs.accessSync(path)) { return null; }
    if (fs.statSync(path).size > MAX_VALUE * 2) { throw new Error('Invalid device row'); }
    let encoded = base64DecodeCanonical(fs.readTextSync(path));
    if (!encoded || encoded.length < 40) { throw new Error('Invalid device row'); }
    let plain = naclSecretboxOpen(encoded.subarray(24), encoded.subarray(0, 24), key);
    if (!plain) { throw new Error('Unreadable device row'); }
    let row = JSON.parse(utf8Decode(plain)) as Record<string, Object>;
    if (row['host'] !== this.hostId || row['table'] !== table || row['key'] !== name
      || typeof row['value'] !== 'string' || (row['value'] as string).length > MAX_VALUE) {
      throw new Error('Invalid device row identity');
    }
    return row['value'] as string;
  }
  private encodeValue(table: string, name: string, value: string, key: Uint8Array): string {
    let nonce = naclRandomBytes(24);
    let row: Record<string, string> = { 'host': this.hostId, 'table': table, 'key': name, 'value': value };
    return base64Encode(concatBytes([nonce, naclSecretbox(utf8Encode(JSON.stringify(row)), nonce, key)]));
  }
  private commitValue(path: string, value: string | null): void {
    if (value === null) { if (fs.accessSync(path)) { fs.unlinkSync(path); } return; }
    let temp = `${path}.tmp`;
    let committed = false;
    try {
      let file = fs.openSync(temp, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      try {
        if (fs.writeSync(file.fd, value) !== value.length) { throw new Error('Device row write incomplete'); }
        fs.fsyncSync(file.fd);
      } finally { fs.closeSync(file); }
      fs.renameSync(temp, path); committed = true;
    } finally { if (!committed && fs.accessSync(temp)) { fs.unlinkSync(temp); } }
  }
  serve(params: ESObject): Promise<Object> {
    this.validate(params);
    return this.enqueue(params);
  }
  // Only native Home can record that the authenticated catalog proved these counts.
  async readHomeCounts(pairedAt: number): Promise<HomeWorktreeCounts | null> {
    let result = await this.enqueue({ action: 'read', table: HOME_TABLE, keys: [HOME_COUNTS_KEY] });
    let encoded = result.values?.[0];
    if (!encoded) { return null; }
    try {
      let value = JSON.parse(encoded) as HomeWorktreeCounts;
      if (value?.pairedAt === pairedAt && Number.isSafeInteger(value.totalWorktrees) && value.totalWorktrees >= 0
        && Number.isSafeInteger(value.activeCount) && value.activeCount >= 0 && value.activeCount <= value.totalWorktrees) {
        return { pairedAt: pairedAt, totalWorktrees: value.totalWorktrees, activeCount: value.activeCount };
      }
    } catch (e) { }
    return null;
  }
  async writeHomeCounts(counts: HomeWorktreeCounts): Promise<boolean> {
    let value: HomeWorktreeCounts = {
      pairedAt: counts.pairedAt, totalWorktrees: counts.totalWorktrees, activeCount: counts.activeCount
    };
    let op: RowOp = { key: HOME_COUNTS_KEY, value: JSON.stringify(value) };
    let result = await this.enqueue({ action: 'write', table: HOME_TABLE, ops: [op] });
    return result.written === true;
  }
  private enqueue(params: ESObject): Promise<RowResult> {
    let previous = queues.get(this.hostId) ?? Promise.resolve<RowResult>({});
    let next: Promise<RowResult> = previous.catch((): RowResult => ({}))
      .then((): Promise<RowResult> => this.perform(params)).finally((): void => {
        if (queues.get(this.hostId) === next) { queues.delete(this.hostId); }
      });
    queues.set(this.hostId, next);
    return next;
  }
  private validate(params: ESObject): void {
    if (!params || typeof params !== 'object' || Array.isArray(params)
      || !['cache', 'draft'].includes(params['table']) || !['read', 'write'].includes(params['action'])) {
      throw new Error('Invalid device store params');
    }
    let keys = Object.keys(params).sort().join(',');
    if (params['action'] === 'read') {
      if (keys !== 'action,keys,table' || !Array.isArray(params['keys'])
        || params['keys'].length < 1 || params['keys'].length > 64) { throw new Error('Invalid device store keys'); }
      let names: string[] = params['keys'];
      for (let i = 0; i < names.length; i++) { this.validateKey(names[i]); }
    } else {
      if (keys !== 'action,ops,table' || !Array.isArray(params['ops'])
        || params['ops'].length < 1 || params['ops'].length > 64) { throw new Error('Invalid device store ops'); }
      let ops: RowOp[] = params['ops'];
      for (let i = 0; i < ops.length; i++) {
        let op = ops[i];
        if (!op || Object.keys(op).sort().join(',') !== 'key,value'
          || (op.value !== null && typeof op.value !== 'string')) { throw new Error('Invalid device store op'); }
        this.validateKey(op.key);
      }
    }
  }
  private validateKey(key: string): void {
    if (typeof key !== 'string' || key.length < 1 || key.length > 512) { throw new Error('Invalid device store key'); }
  }
  private async perform(params: ESObject): Promise<RowResult> {
    let writing = params['action'] === 'write';
    try {
      let table: string = params['table'];
      if (!writing && table === HOME_TABLE && !fs.accessSync(this.path(HOME_TABLE, HOME_COUNTS_KEY))) {
        return { values: [null] };
      }
      let key = await this.openKey();
      if (!writing) {
        let names: string[] = params['keys'];
        let values: Array<string | null> = []; let deferred: number[] = []; let filled = 0;
        for (let i = 0; i < names.length; i++) {
          if (filled + MAX_VALUE > READ_BUDGET) { values.push(null); deferred.push(i); continue; }
          let value = this.readValue(table, names[i], key);
          if (value !== null) { filled += value.length; }
          values.push(value);
        }
        return { values: values, deferred: deferred };
      }
      let ops: RowOp[] = params['ops'];
      for (let i = 0; i < ops.length; i++) {
        if (ops[i].value !== null && ops[i].value!.length > MAX_VALUE) {
          return { written: false, refusal: 'too-large' };
        }
      }
      let changes: Map<string, string | null> = new Map();
      for (let i = 0; i < ops.length; i++) {
        let op = ops[i];
        let encoded = op.value === null ? null : this.encodeValue(table, op.key, op.value, key);
        if (encoded !== null && encoded.length > MAX_VALUE * 2) { return { written: false, refusal: 'too-large' }; }
        changes.set(this.path(table, op.key), encoded);
      }
      let root = this.tableRoot(table);
      let files = this.files(root); let total = 0;
      for (let i = 0; i < files.length; i++) {
        if (!changes.has(files[i].path)) { total += files[i].bytes; }
      }
      changes.forEach((value: string | null): void => { if (value !== null) { total += Math.max(4096, value.length); } });
      let cap = (table === 'draft' ? 16 : 128) * 1024 * 1024;
      if (total > cap && table === 'draft') { return { written: false, refusal: 'over-cap' }; }
      if (total > cap) {
        files.sort((a: RowFile, b: RowFile): number => a.modified - b.modified);
        for (let i = 0; i < files.length && total > cap; i++) {
          if (!changes.has(files[i].path)) { fs.unlinkSync(files[i].path); total -= files[i].bytes; }
        }
        if (total > cap) { return { written: false, refusal: 'over-cap' }; }
      }
      let directory = this.root(table);
      if (!fs.accessSync(directory)) { fs.mkdirSync(directory, true); }
      changes.forEach((value: string | null, path: string): void => this.commitValue(path, value));
      return { written: true };
    } catch (e) {
      return writing ? { written: false, refusal: 'unavailable' } : { refusal: 'unavailable' };
    }
  }
}

export async function deleteDeviceRows(context: common.Context, hostId: string): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(hostId)) { return; }
  let pending = queues.get(hostId);
  if (pending) { await pending.catch((): RowResult => ({})); }
  for (let root of [context.filesDir, context.cacheDir]) {
    let path = `${root}/orca-rows/${hostId}`;
    if (fs.accessSync(path)) { fs.rmdirSync(path); }
  }
  let query: asset.AssetMap = new Map(); query.set(asset.Tag.ALIAS, utf8Encode(`orca.rows.key.${hostId}`));
  try { await asset.remove(query); }
  catch (e) { if ((e as BusinessError).code !== asset.ErrorCode.NOT_FOUND) { throw e as Error; } }
}
