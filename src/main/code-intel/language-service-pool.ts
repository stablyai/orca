import { dirname } from 'path'
import ts from 'typescript'

export type LanguageServiceEntry = {
  projectRoot: string
  service: ts.LanguageService
}

type Overlay = { text: string; version: number }

type PoolOptions = { maxServices: number; idleMs: number }

export class LanguageServicePool {
  private readonly services = new Map<string, ts.LanguageService>()
  private readonly lastUsed = new Map<string, number>()
  private readonly fileVersions = new Map<string, number>()
  private overlay: ({ filePath: string } & Overlay) | null = null

  constructor(private readonly options: PoolOptions) {}

  size(): number {
    return this.services.size
  }

  setOverlay(filePath: string, text: string, version: number): void {
    this.overlay = { filePath: this.normalize(filePath), text, version }
    this.bumpVersion(filePath)
  }

  clearOverlay(): void {
    if (this.overlay) {
      const path = this.overlay.filePath
      this.overlay = null
      this.bumpVersion(path)
    }
  }

  acquire(filePath: string): LanguageServiceEntry | null {
    const projectRoot = this.findProjectRoot(filePath)
    if (!projectRoot) {
      return null
    }
    this.evictIdle()
    let service = this.services.get(projectRoot)
    if (!service) {
      service = this.createService(projectRoot)
      this.services.set(projectRoot, service)
      this.enforceCap(projectRoot)
    }
    this.lastUsed.set(projectRoot, this.now())
    return { projectRoot, service }
  }

  disposeAll(): void {
    for (const service of this.services.values()) {
      service.dispose()
    }
    this.services.clear()
    this.lastUsed.clear()
  }

  private findProjectRoot(filePath: string): string | null {
    const configPath = ts.findConfigFile(dirname(filePath), ts.sys.fileExists, 'tsconfig.json')
    return configPath ? dirname(configPath) : null
  }

  private createService(projectRoot: string): ts.LanguageService {
    const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsconfig.json')!
    const parsed = ts.parseJsonConfigFileContent(
      ts.readConfigFile(configPath, ts.sys.readFile).config ?? {},
      ts.sys,
      projectRoot
    )
    const compilerOptions: ts.CompilerOptions = { ...parsed.options, allowJs: true }
    const fileNames = new Set(parsed.fileNames)

    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => {
        const names = new Set(fileNames)
        if (this.overlay) {
          names.add(this.overlay.filePath)
        }
        return [...names]
      },
      getScriptVersion: (fileName) => String(this.fileVersions.get(this.normalize(fileName)) ?? 0),
      getScriptSnapshot: (fileName) => {
        const normalized = this.normalize(fileName)
        if (this.overlay && this.overlay.filePath === normalized) {
          return ts.ScriptSnapshot.fromString(this.overlay.text)
        }
        const onDisk = ts.sys.readFile(fileName)
        return onDisk === undefined ? undefined : ts.ScriptSnapshot.fromString(onDisk)
      },
      getCurrentDirectory: () => projectRoot,
      getCompilationSettings: () => compilerOptions,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories
    }

    return ts.createLanguageService(host, ts.createDocumentRegistry())
  }

  private enforceCap(justAdded: string): void {
    while (this.services.size > this.options.maxServices) {
      let oldest: string | null = null
      let oldestTime = Infinity
      for (const [root, time] of this.lastUsed) {
        if (root !== justAdded && time < oldestTime) {
          oldest = root
          oldestTime = time
        }
      }
      if (!oldest) {
        break
      }
      this.services.get(oldest)?.dispose()
      this.services.delete(oldest)
      this.lastUsed.delete(oldest)
    }
  }

  private evictIdle(): void {
    const cutoff = this.now() - this.options.idleMs
    // Why: snapshot entries before iterating since the loop deletes from the map.
    for (const [root, time] of Array.from(this.lastUsed)) {
      if (time < cutoff) {
        this.services.get(root)?.dispose()
        this.services.delete(root)
        this.lastUsed.delete(root)
      }
    }
  }

  private bumpVersion(filePath: string): void {
    const normalized = this.normalize(filePath)
    this.fileVersions.set(normalized, (this.fileVersions.get(normalized) ?? 0) + 1)
  }

  private normalize(filePath: string): string {
    return filePath.replace(/\\/g, '/')
  }

  private now(): number {
    return Date.now()
  }
}
