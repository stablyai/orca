import { lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { writeDevinCredentialFile } from './devin-credential-file'

const MAX_CREDENTIAL_BYTES = 16 * 1024 * 1024
const backupStateSchema = z.object({ hadCredentials: z.boolean() })

async function regularFileContents(path: string): Promise<string> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CREDENTIAL_BYTES) {
    throw new Error('Devin credential sync requires a regular file smaller than 16 MiB.')
  }
  return readFile(path, 'utf8')
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function resolveAppDataRoot(appDataRoot?: string): string {
  const appData = appDataRoot ?? process.env.APPDATA?.trim()
  return appData && isAbsolute(appData) ? appData : join(homedir(), 'AppData', 'Roaming')
}

export type DevinHostCredentialSyncOptions = {
  appDataRoot?: string
}

/** Mirrors the selected profile into Devin's Windows-only global credential location. */
export class DevinHostCredentialSync {
  private readonly providerRoot: string
  private readonly defaultCredentialsPath: string
  private readonly backupPath: string
  private readonly statePath: string

  constructor(root: string, options: DevinHostCredentialSyncOptions = {}) {
    this.providerRoot = join(root, 'devin')
    this.defaultCredentialsPath = join(
      resolveAppDataRoot(options.appDataRoot),
      'devin',
      'credentials.toml'
    )
    this.backupPath = join(this.providerRoot, 'system-default-credentials.toml')
    this.statePath = join(this.providerRoot, 'system-default-credentials.json')
  }

  async activate(accountDirectory: string): Promise<void> {
    const source = join(accountDirectory, 'data', 'devin', 'credentials.toml')
    const contents = await regularFileContents(source)
    await this.captureSystemDefault()
    if (!(await writeDevinCredentialFile(this.defaultCredentialsPath, contents))) {
      throw new Error('Could not restrict the active Devin credential file permissions.')
    }
  }

  async restoreSystemDefault(): Promise<void> {
    const saved = await this.readBackupState()
    if (!saved) {
      await this.removeOrphanBackup()
      return
    }

    if (saved.hadCredentials) {
      const contents = await regularFileContents(this.backupPath)
      if (!(await writeDevinCredentialFile(this.defaultCredentialsPath, contents))) {
        throw new Error('Could not restore the system Devin credential file permissions.')
      }
    } else if (await fileExists(this.defaultCredentialsPath)) {
      await regularFileContents(this.defaultCredentialsPath)
      await rm(this.defaultCredentialsPath)
    }

    await rm(this.statePath)
    const backupExists = saved.hadCredentials && (await fileExists(this.backupPath))
    await (backupExists ? rm(this.backupPath) : this.removeOrphanBackup())
  }

  private async captureSystemDefault(): Promise<void> {
    if (await this.readBackupState()) {
      return
    }
    await this.removeOrphanBackup()

    const hadCredentials = await fileExists(this.defaultCredentialsPath)
    if (hadCredentials) {
      const contents = await regularFileContents(this.defaultCredentialsPath)
      if (!(await writeDevinCredentialFile(this.backupPath, contents))) {
        await rm(this.backupPath, { force: true })
        throw new Error('Could not restrict the system Devin credential backup permissions.')
      }
    }

    await mkdir(this.providerRoot, { recursive: true, mode: 0o700 })
    if (!(await writeDevinCredentialFile(this.statePath, JSON.stringify({ hadCredentials })))) {
      await rm(this.statePath, { force: true })
      await rm(this.backupPath, { force: true })
      throw new Error('Could not restrict the system Devin credential backup metadata.')
    }
  }

  private async readBackupState(): Promise<z.infer<typeof backupStateSchema> | null> {
    if (!(await fileExists(this.statePath))) {
      return null
    }
    const contents = await regularFileContents(this.statePath)
    const state = backupStateSchema.parse(JSON.parse(contents))
    if (state.hadCredentials) {
      if (!(await fileExists(this.backupPath))) {
        throw new Error('The system Devin credential backup is missing.')
      }
      await regularFileContents(this.backupPath)
    }
    return state
  }

  private async removeOrphanBackup(): Promise<void> {
    if (await fileExists(this.backupPath)) {
      await regularFileContents(this.backupPath)
      await rm(this.backupPath)
    }
  }
}
