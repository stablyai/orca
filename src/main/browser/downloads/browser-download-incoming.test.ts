import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserDownloadDestinationReservations } from './browser-download-destination'
import { promoteDownloadedFileWithoutOverwrite } from '../../ipc/filesystem/downloads/filesystem-download-promotion'

const dirs: string[] = []

async function downloadsFolder(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'incoming-download-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('a file another machine sends into Downloads', () => {
  it('lands in Downloads under a visible, unused name, whatever name was sent', async () => {
    const downloadsPath = await downloadsFolder()
    const reservations = new BrowserDownloadDestinationReservations({
      downloadsPath,
      platform: 'win32'
    })
    await writeFile(path.join(downloadsPath, 'q3-report.pdf'), 'mine')
    const names = new Map<string, string>()
    for (const sent of [
      'q3-report.pdf',
      '../../x',
      '..\\..\\x',
      '/etc/passwd',
      '.bashrc',
      '. .hidden',
      '..',
      'CON',
      '.nul.txt'
    ]) {
      const { savePath, filename } = await reservations.reserveIncoming(sent)
      expect(path.dirname(savePath)).toBe(downloadsPath)
      names.set(sent, filename)
    }
    expect(Object.fromEntries(names)).toEqual({
      'q3-report.pdf': 'q3-report (1).pdf',
      '../../x': 'x',
      '..\\..\\x': 'x (1)',
      '/etc/passwd': 'passwd',
      '.bashrc': 'bashrc',
      '. .hidden': 'hidden',
      '..': 'download',
      CON: '_CON',
      '.nul.txt': '_nul.txt'
    })
  })

  it('never replaces a file that took its name while it downloaded', async () => {
    const downloadsPath = await downloadsFolder()
    const reservations = new BrowserDownloadDestinationReservations({ downloadsPath })
    const reserved = await reservations.reserveIncoming('report.pdf')
    const tempPath = path.join(downloadsPath, '.part')
    await writeFile(tempPath, 'copied')
    // Something else saved report.pdf meanwhile.
    await writeFile(reserved.savePath, 'theirs')

    const savedAt = await promoteDownloadedFileWithoutOverwrite(
      tempPath,
      reserved.savePath,
      async () => (await reservations.reserveIncoming('report.pdf')).savePath
    )

    expect(path.basename(savedAt)).toBe('report (1).pdf')
    expect(await readFile(reserved.savePath, 'utf8')).toBe('theirs')
    expect(await readFile(savedAt, 'utf8')).toBe('copied')
    expect((await readdir(downloadsPath)).sort()).toEqual(['report (1).pdf', 'report.pdf'])
  })
})
