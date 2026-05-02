/* eslint-disable max-lines -- Why: the embedded Docker-side filesystem scripts
 * stay next to the provider methods so path, stdin, and size-limit contracts
 * can be audited together. */
import type { DockerEngineClientLike } from '../docker/docker-engine-client'
import { DockerEngineClient } from '../docker/docker-engine-client'
import { resolveDockerContainerPath } from '../docker/docker-container-path'
import type { DockerTarget } from '../docker/types'
import type { IFilesystemProvider, FileReadResult, FileStat } from './types'
import type { DirEntry, FsChangeEvent, SearchOptions, SearchResult } from '../../shared/types'
import {
  buildRgArgs,
  createAccumulator,
  DEFAULT_SEARCH_MAX_RESULTS,
  finalize,
  ingestRgJsonLine
} from '../../shared/text-search'

const MAX_DOCKER_FILE_READ_BYTES = 10 * 1024 * 1024
const MAX_DOCKER_SEARCH_SCANNED_FILES = 10_000

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
    return this.execNodeJson<DirEntry[]>(READ_DIR_SCRIPT, [this.containerPath(dirPath)])
  }

  async readFile(filePath: string): Promise<FileReadResult> {
    return this.execNodeJson<FileReadResult>(READ_FILE_SCRIPT, [
      this.containerPath(filePath),
      String(MAX_DOCKER_FILE_READ_BYTES)
    ])
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await this.execNodeVoid(WRITE_FILE_SCRIPT, [this.containerPath(filePath)], content)
  }

  async writeFileBase64(filePath: string, contentBase64: string): Promise<void> {
    await this.writeFileBase64Chunk(filePath, contentBase64, false)
  }

  async writeFileBase64Chunk(
    filePath: string,
    contentBase64: string,
    append: boolean
  ): Promise<void> {
    await this.execNodeVoid(
      WRITE_FILE_BASE64_SCRIPT,
      [this.containerPath(filePath), append ? '1' : '0'],
      contentBase64
    )
  }

  async stat(filePath: string): Promise<FileStat> {
    return this.execNodeJson<FileStat>(STAT_SCRIPT, [this.containerPath(filePath)])
  }

  async deletePath(targetPath: string, recursive?: boolean): Promise<void> {
    await this.execNodeVoid(DELETE_PATH_SCRIPT, [
      this.containerPath(targetPath),
      recursive ? '1' : '0'
    ])
  }

  async createFile(filePath: string): Promise<void> {
    await this.execNodeVoid(CREATE_FILE_SCRIPT, [this.containerPath(filePath)])
  }

  async createDir(dirPath: string): Promise<void> {
    await this.execNodeVoid(CREATE_DIR_SCRIPT, [this.containerPath(dirPath)])
  }

  async createDirNoClobber(dirPath: string): Promise<void> {
    await this.execNodeVoid(CREATE_DIR_NO_CLOBBER_SCRIPT, [this.containerPath(dirPath)])
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.execNodeVoid(RENAME_SCRIPT, [
      this.containerPath(oldPath),
      this.containerPath(newPath)
    ])
  }

  async renameNoClobber(oldPath: string, newPath: string): Promise<void> {
    await this.execNodeVoid(RENAME_NO_CLOBBER_SCRIPT, [
      this.containerPath(oldPath),
      this.containerPath(newPath)
    ])
  }

  async copy(source: string, destination: string): Promise<void> {
    await this.execNodeVoid(COPY_SCRIPT, [
      this.containerPath(source),
      this.containerPath(destination)
    ])
  }

  async realpath(filePath: string): Promise<string> {
    return this.execNodeJson<string>(REALPATH_SCRIPT, [this.containerPath(filePath)])
  }

  async search(opts: SearchOptions): Promise<SearchResult> {
    const maxResults = Math.max(
      1,
      Math.min(opts.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS, DEFAULT_SEARCH_MAX_RESULTS)
    )
    const rgArgs = buildRgArgs(opts.query, opts.rootPath, opts)
    // Why: mirroring the host rg pipeline keeps regex, word-boundary, and
    // include/exclude glob semantics identical for Docker-isolated worktrees.
    const result = await this.engine.exec({
      containerId: this.target.containerId,
      args: ['rg', ...rgArgs],
      cwd: opts.rootPath,
      input: '',
      timeoutMs: 15_000,
      allowExitCodes: [0, 1]
    })
    const acc = createAccumulator()
    for (const line of result.stdout.split(/\r?\n/)) {
      if (ingestRgJsonLine(line, opts.rootPath, acc, maxResults) === 'stop') {
        break
      }
    }
    return finalize(acc)
  }

  async listFiles(rootPath: string, options?: { excludePaths?: string[] }): Promise<string[]> {
    return this.execNodeJson<string[]>(LIST_FILES_SCRIPT, [
      this.containerPath(rootPath),
      JSON.stringify(
        (options?.excludePaths ?? []).map((excludePath) => this.containerPath(excludePath))
      ),
      String(MAX_DOCKER_SEARCH_SCANNED_FILES)
    ])
  }

  async watch(rootPath: string, callback: (events: FsChangeEvent[]) => void): Promise<() => void> {
    const containerRoot = this.containerPath(rootPath)
    this.watchListeners.set(containerRoot, callback)
    await this.engine.exec({
      containerId: this.target.containerId,
      args: ['sh', '-lc', 'true'],
      cwd: containerRoot
    })
    return () => {
      this.watchListeners.delete(containerRoot)
    }
  }

  private containerPath(filePath: string): string {
    return resolveDockerContainerPath(this.target, filePath)
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
const maxBytes = Number(process.argv[2]);
const stat = fs.statSync(filePath);
if (stat.size > maxBytes) throw new Error('File is too large to read through Docker provider');
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
const WRITE_FILE_BASE64_SCRIPT = `
const fs = require('fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const buffer = Buffer.from(input, 'base64');
  fs.writeFileSync(process.argv[1], buffer, process.argv[2] === '1' ? { flag: 'a' } : undefined);
});
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
const CREATE_DIR_NO_CLOBBER_SCRIPT = `
const fs = require('fs');
fs.mkdirSync(process.argv[1]);
`
const RENAME_SCRIPT = `
const fs = require('fs');
fs.renameSync(process.argv[1], process.argv[2]);
`
const RENAME_NO_CLOBBER_SCRIPT = `
const fs = require('fs');
if (fs.existsSync(process.argv[2])) throw new Error('Destination already exists');
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
const maxFiles = Number(process.argv[3]);
const out = [];
function walk(dir) {
  if (out.length >= maxFiles) return;
  if (excludes.has(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const abs = path.join(dir, entry.name);
    if (excludes.has(abs)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(abs);
    else out.push(path.relative(root, abs).replace(/\\\\/g, '/'));
  }
}
walk(root);
process.stdout.write(JSON.stringify(out.sort()));
`
