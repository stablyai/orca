import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import {
  MAX_NATIVE_HANG_ARTIFACT_BYTES,
  parseNativeHangArtifact,
  type NativeHangArtifact
} from './native-hang-report'

const CAPTURE_ID = /^hang-(\d{1,16})-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/
const CAPTURE_FILE = /^(hang-\d{1,16}-[\da-f-]{36})(\.(?:recovered|seen))?\.json$/
type CaptureFile = { name: string; captureId: string; detectedAt: number; state: string }
export type StoredNativeHangCapture = { artifact: NativeHangArtifact; path: string; state: string }

export function nativeHangCaptureDirectory(userDataPath: string): string {
  return join(userDataPath, 'hang-captures')
}

export function createNativeHangCaptureId(detectedAt: number): string {
  return `hang-${detectedAt}-${randomUUID()}`
}

function captureFile(name: string): CaptureFile | null {
  const match = CAPTURE_FILE.exec(name)
  const id = match && CAPTURE_ID.exec(match[1]!)
  return match && id
    ? { name, captureId: match[1]!, detectedAt: Number(id[1]), state: match[2] ?? '' }
    : null
}

async function entries(directory: string): Promise<string[] | null> {
  try {
    if (!(await fs.lstat(directory)).isDirectory()) {
      return null
    }
    const handle = await fs.opendir(directory)
    try {
      const names: string[] = []
      while (names.length < 64) {
        const entry = await handle.read()
        if (!entry) {
          return names
        }
        names.push(entry.name)
      }
      return null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

export async function listNativeHangCaptures(directory: string): Promise<CaptureFile[]> {
  return ((await entries(directory)) ?? [])
    .map(captureFile)
    .filter((file): file is CaptureFile => file !== null)
    .sort((a, b) => b.detectedAt - a.detectedAt || b.name.localeCompare(a.name))
}

async function readCaptureFile(
  directory: string,
  file: CaptureFile
): Promise<StoredNativeHangCapture | null> {
  const filePath = join(directory, file.name)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_NATIVE_HANG_ARTIFACT_BYTES) {
      return null
    }
    const bytes = Buffer.alloc(stat.size + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== stat.size) {
      return null
    }
    const parsed: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
    const artifact = parseNativeHangArtifact(parsed)
    return artifact &&
      artifact.captureId === file.captureId &&
      artifact.detectedAt === file.detectedAt
      ? { artifact, path: filePath, state: file.state }
      : null
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

export async function readNativeHangCapture(
  directory: string,
  captureId?: string
): Promise<StoredNativeHangCapture | null> {
  const files = captureId
    ? CAPTURE_ID.test(captureId)
      ? ['', '.seen', '.recovered'].map((state) => captureFile(`${captureId}${state}.json`)!)
      : []
    : await listNativeHangCaptures(directory)
  for (const file of files) {
    const capture = await readCaptureFile(directory, file)
    if (capture) {
      return capture
    }
  }
  return null
}

export async function readPreviousNativeHangCapture(
  directory: string,
  processStartedAt: number
): Promise<StoredNativeHangCapture | null> {
  for (const file of await listNativeHangCaptures(directory)) {
    if (!file.state && file.detectedAt < processStartedAt) {
      const capture = await readCaptureFile(directory, file)
      if (capture) {
        return capture
      }
    }
  }
  return null
}

export async function claimNativeHangCapture(
  directory: string,
  captureId: string,
  processStartedAt: number
): Promise<boolean> {
  try {
    const files = (await listNativeHangCaptures(directory)).filter(
      (file) => !file.state && file.detectedAt < processStartedAt
    )
    if (!files.some((file) => file.captureId === captureId)) {
      return false
    }
    // Claim the selected incident last so a failed older rename cannot consume its notice.
    for (const file of files.toReversed().filter((file) => file.captureId !== captureId)) {
      await fs.rename(join(directory, file.name), join(directory, `${file.captureId}.seen.json`))
    }
    await fs.rename(join(directory, `${captureId}.json`), join(directory, `${captureId}.seen.json`))
    return true
  } catch {
    return false
  }
}

export class NativeHangCaptureStore {
  private busy = false

  constructor(private readonly directory: string) {}

  async save(artifact: NativeHangArtifact, recovered: () => boolean): Promise<void> {
    if (this.busy || !CAPTURE_ID.test(artifact.captureId)) {
      return
    }
    this.busy = true
    const temporary = join(this.directory, `${artifact.captureId}.tmp`)
    try {
      const safe = parseNativeHangArtifact(artifact)
      if (!safe) {
        return
      }
      const payload = `${JSON.stringify(safe)}\n`
      if (Buffer.byteLength(payload) > MAX_NATIVE_HANG_ARTIFACT_BYTES) {
        return
      }
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
      if (!(await fs.lstat(this.directory)).isDirectory()) {
        return
      }
      await fs.chmod(this.directory, 0o700)
      const names = await entries(this.directory)
      if (!names) {
        return
      }
      const captures = names
        .map(captureFile)
        .filter((file): file is CaptureFile => !!file)
        .sort((a, b) => b.detectedAt - a.detectedAt)
      for (const name of names) {
        if (name.endsWith('.tmp') && CAPTURE_ID.test(name.slice(0, -4))) {
          await fs.unlink(join(this.directory, name))
        }
      }
      for (const [index, file] of captures.entries()) {
        const stat = await fs.lstat(join(this.directory, file.name))
        if (index >= 3 || stat.size > MAX_NATIVE_HANG_ARTIFACT_BYTES || !stat.isFile()) {
          await fs.unlink(join(this.directory, file.name))
        }
      }
      await fs.writeFile(temporary, payload, { mode: 0o600, flag: 'wx' })
      const state = recovered() ? '.recovered' : ''
      await fs.rename(temporary, join(this.directory, `${artifact.captureId}${state}.json`))
      if (!state && recovered()) {
        await this.renameRecovered(artifact.captureId)
      }
    } catch {
      // Optional full evidence must not interrupt marker capture or child cleanup.
    } finally {
      await fs.unlink(temporary).catch(() => {})
      if (recovered()) {
        await this.renameRecovered(artifact.captureId).catch(() => {})
      }
      this.busy = false
    }
  }

  async recover(captureId: string): Promise<void> {
    if (!this.busy && CAPTURE_ID.test(captureId)) {
      await this.renameRecovered(captureId).catch(() => {})
    }
  }

  private async renameRecovered(captureId: string): Promise<void> {
    await fs.rename(
      join(this.directory, `${captureId}.json`),
      join(this.directory, `${captureId}.recovered.json`)
    )
  }
}
