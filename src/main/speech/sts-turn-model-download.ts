import { mkdir, readFile, rename, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { STS_TURN_MODEL_FILES, type StsTurnModelAsset } from '../../shared/sts-turn-models'
import { SpeechModelDownloadTransport } from './speech-model-download-transport'
import type { OpenSpeechDownloadRequest } from './speech-model-download-response'

export class StsTurnModelDownload extends SpeechModelDownloadTransport {
  private pending: Promise<StsTurnModelAsset[]> | undefined

  constructor(
    private readonly directory: string,
    openRequest: OpenSpeechDownloadRequest
  ) {
    super(openRequest)
  }

  protected reportDownloadProgress(): void {}

  load(): Promise<StsTurnModelAsset[]> {
    this.pending ??= this.prepare().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  private async prepare(): Promise<StsTurnModelAsset[]> {
    await mkdir(this.directory, { recursive: true })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10 * 60_000)
    try {
      const result: StsTurnModelAsset[] = []
      for (const file of STS_TURN_MODEL_FILES) {
        const target = join(this.directory, file.name)
        let valid = false
        try {
          if ((await stat(target)).size === file.sizeBytes) {
            await this.verifyFileSha256(target, file.sha256)
            valid = true
          }
        } catch {
          /* Re-download only the fixed, verified model asset. */
        }
        if (!valid) {
          const partial = `${target}.partial`
          try {
            if ((await stat(partial)).size > file.sizeBytes) {
              await rm(partial)
            }
          } catch {
            /* A missing partial starts at byte zero. */
          }
          await this.downloadFileWithRetry(
            file.url,
            partial,
            file.sizeBytes,
            'sts-turn-models',
            () => controller.signal.aborted,
            controller.signal
          )
          try {
            await this.verifyFileSha256(partial, file.sha256)
          } catch (error) {
            await rm(partial, { force: true })
            throw error
          }
          await rename(partial, target)
        }
        result.push({ name: file.name, bytes: new Uint8Array(await readFile(target)) })
      }
      return result
    } finally {
      clearTimeout(timer)
    }
  }
}
