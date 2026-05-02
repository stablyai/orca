import type { DockerEngineClientLike } from '../docker/docker-engine-client'
import { DockerEngineClient } from '../docker/docker-engine-client'
import type { DockerTarget } from '../docker/types'
import type { IFilesystemProvider, FileReadResult, FileStat } from './types'
import type { DirEntry, FsChangeEvent, SearchOptions, SearchResult } from '../../shared/types'

export class DockerFilesystemProvider implements IFilesystemProvider {
  private target: DockerTarget
  private engine: DockerEngineClientLike
  private watchListeners = new Map<string, (events: FsChangeEvent[]) => void>()

  constructor(target: DockerTarget, engine: DockerEngineClientLike = new DockerEngineClient()) {
    this.target = target
    this.engine = engine
  }

  getConnectionId(): string {
    return this.target.containerId
  }

  async readDir(dirPath: string): Promise<DirEntry[]> {
    return this.execNodeJson<DirEntry[]>(READ_DIR_SCRIPT, [dirPath])
  }

  async readFile(filePath: string): Promise<FileReadResult> {
    return this.execNodeJson<FileReadResult>(READ_FILE_SCRIPT, [filePath])
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await this.execNodeVoid(WRITE_FILE_SCRIPT, [filePath], content)
  }

  async stat(filePath: string): Promise<FileStat> {
    return this.execNodeJson<FileStat>(STAT_SCRIPT, [filePath])
  }

  async deletePath(targetPath: string, recursive?: boolean): Promise<void> {
    await this.execNodeVoid(DELETE_PATH_SCRIPT, [targetPath, recursive ? '1' : '0'])
  }

  async createFile(filePath: string): Promise<void> {
    await this.execNodeVoid(CREATE_FILE_SCRIPT, [filePath])
  }

  async createDir(dirPath: string): Promise<void> {
    await this.execNodeVoid(CREATE_DIR_SCRIPT, [dirPath])
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.execNodeVoid(RENAME_SCRIPT, [oldPath, newPath])
  }

  async copy(source: string, destination: string): Promise<void> {
    await this.execNodeVoid(COPY_SCRIPT, [source, destination])
  }

  async realpath(filePath: string): Promise<string> {
    return this.execNodeJson<string>(REALPATH_SCRIPT, [filePath])
  }

  async search(opts: SearchOptions): Promise<SearchResult> {
    return this.execNodeJson<SearchResult>(SEARCH_SCRIPT, [JSON.stringify(opts)])
  }

  async listFiles(rootPath: string, options?: { excludePaths?: string[] }): Promise<string[]> {
    return this.execNodeJson<string[]>(LIST_FILES_SCRIPT, [
      rootPath,
      JSON.stringify(options?.excludePaths ?? [])
    ])
  }

  async watch(rootPath: string, callback: (events: FsChangeEvent[]) => void): Promise<() => void> {
    this.watchListeners.set(rootPath, callback)
    await this.engine.exec({
      containerId: this.target.containerId,
      args: ['sh', '-lc', 'true'],
      cwd: rootPath
    })
    return () => {
      this.watchListeners.delete(rootPath)
    }
  }

  private async execNodeJson<T>(script: string, args: string[], input?: string): Promise<T> {
    const result = await this.engine.exec({
      containerId: this.target.containerId,
      args: ['node', '-e', script, ...args],
      cwd: this.target.workdir,
      input
    })
    return JSON.parse(result.stdout) as T
  }

  private async execNodeVoid(script: string, args: string[], input?: string): Promise<void> {
    await this.engine.exec({
      containerId: this.target.containerId,
      args: ['node', '-e', script, ...args],
      cwd: this.target.workdir,
      input
    })
  }
}

const READ_DIR_SCRIPT = `
const fs = require('fs');
const entries = fs.readdirSync(process.argv[1], { withFileTypes: true })
  .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isSymlink: entry.isSymbolicLink() }))
  .sort((a, b) => a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name));
process.stdout.write(JSON.stringify(entries));
`
const READ_FILE_SCRIPT = `
const fs = require('fs');
const filePath = process.argv[1];
const buffer = fs.readFileSync(filePath);
const isBinary = buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
process.stdout.write(JSON.stringify({ content: isBinary ? '' : buffer.toString('utf8'), isBinary }));
`
const WRITE_FILE_SCRIPT = `
const fs = require('fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => fs.writeFileSync(process.argv[1], input, 'utf8'));
`
const STAT_SCRIPT = `
const fs = require('fs');
const stat = fs.lstatSync(process.argv[1]);
process.stdout.write(JSON.stringify({
  size: stat.size,
  type: stat.isDirectory() ? 'directory' : (stat.isSymbolicLink() ? 'symlink' : 'file'),
  mtime: stat.mtimeMs
}));
`
const DELETE_PATH_SCRIPT = `
const fs = require('fs');
fs.rmSync(process.argv[1], { recursive: process.argv[2] === '1', force: true });
`
const CREATE_FILE_SCRIPT = `
const fs = require('fs');
fs.closeSync(fs.openSync(process.argv[1], 'wx'));
`
const CREATE_DIR_SCRIPT = `
const fs = require('fs');
fs.mkdirSync(process.argv[1], { recursive: true });
`
const RENAME_SCRIPT = `
const fs = require('fs');
fs.renameSync(process.argv[1], process.argv[2]);
`
const COPY_SCRIPT = `
const fs = require('fs');
const stat = fs.lstatSync(process.argv[1]);
if (stat.isDirectory()) fs.cpSync(process.argv[1], process.argv[2], { recursive: true });
else fs.copyFileSync(process.argv[1], process.argv[2]);
`
const REALPATH_SCRIPT = `
const fs = require('fs');
process.stdout.write(JSON.stringify(fs.realpathSync(process.argv[1])));
`
const LIST_FILES_SCRIPT = `
const fs = require('fs');
const path = require('path');
const root = process.argv[1];
const excludes = new Set(JSON.parse(process.argv[2]));
const out = [];
function walk(dir) {
  if (excludes.has(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const abs = path.join(dir, entry.name);
    if (excludes.has(abs)) continue;
    if (entry.isDirectory()) walk(abs);
    else out.push(path.relative(root, abs).replace(/\\\\/g, '/'));
  }
}
walk(root);
process.stdout.write(JSON.stringify(out.sort()));
`
const SEARCH_SCRIPT = `
const fs = require('fs');
const path = require('path');
const opts = JSON.parse(process.argv[1]);
const query = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
const max = opts.maxResults || 2000;
const files = [];
let totalMatches = 0;
function visit(filePath) {
  if (totalMatches >= max) return;
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    if (path.basename(filePath) === '.git') return;
    for (const child of fs.readdirSync(filePath)) visit(path.join(filePath, child));
    return;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const haystack = opts.caseSensitive ? text : text.toLowerCase();
  const matches = [];
  const lines = text.split(/\\r?\\n/);
  for (let i = 0; i < lines.length && totalMatches < max; i++) {
    const lineHaystack = opts.caseSensitive ? lines[i] : lines[i].toLowerCase();
    const column = lineHaystack.indexOf(query);
    if (column >= 0) {
      matches.push({ line: i + 1, column: column + 1, matchLength: opts.query.length, lineContent: lines[i] });
      totalMatches++;
    }
  }
  if (matches.length) files.push({ filePath, relativePath: path.relative(opts.rootPath, filePath).replace(/\\\\/g, '/'), matches });
}
visit(opts.rootPath);
process.stdout.write(JSON.stringify({ files, totalMatches, truncated: totalMatches >= max }));
`
