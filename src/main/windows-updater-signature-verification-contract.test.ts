import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('windows updater electron-updater contract', () => {
  it('keeps the NSIS signature hook and pending installer path adapter surfaces', async () => {
    const nsisUpdaterSource = await readElectronUpdaterOutFile('NsisUpdater.js')

    expect(nsisUpdaterSource).toContain('async verifySignature(tempUpdateFile)')
    expect(nsisUpdaterSource).toContain('this.verifySignature(destinationFile)')
    expect(nsisUpdaterSource).toContain('return await this._verifyUpdateCodeSignature')
    expect(nsisUpdaterSource).toContain('const installerPath = this.installerPath')
  })

  it('keeps cached downloads able to finish before the NSIS verifier task runs', async () => {
    const appUpdaterSource = await readElectronUpdaterOutFile('AppUpdater.js')
    const cacheValidationIndex = appUpdaterSource.indexOf('validateDownloadedPath')
    const cachedDoneIndex = appUpdaterSource.indexOf('return await done(false)')
    const taskRunIndex = appUpdaterSource.indexOf('await taskOptions.task')

    expect(appUpdaterSource).toContain('downloadedFile: updateFile')
    expect(cacheValidationIndex).toBeGreaterThan(-1)
    expect(cachedDoneIndex).toBeGreaterThan(cacheValidationIndex)
    expect(taskRunIndex).toBeGreaterThan(cachedDoneIndex)
  })
})

function readElectronUpdaterOutFile(fileName: string): Promise<string> {
  return readFile(join(process.cwd(), 'node_modules', 'electron-updater', 'out', fileName), 'utf8')
}
