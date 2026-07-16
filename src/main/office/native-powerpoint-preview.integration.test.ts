import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import JSZip from 'jszip'
import { expect, it } from 'vitest'
import { renderNativePowerPointPreview } from './native-powerpoint-preview'

const execFileAsync = promisify(execFile)
const runPowerPointIntegration =
  process.platform === 'win32' && process.env.ORCA_PPTX_COM_TEST === '1' ? it : it.skip

const CREATE_VISUAL_DECK_SCRIPT = String.raw`
param([Parameter(Mandatory = $true)][string]$OutputPath)

$ErrorActionPreference = 'Stop'
$powerPoint = $null
$presentation = $null
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $presentation = $powerPoint.Presentations.Add($false)
  $slide = $presentation.Slides.Add(1, 12)
  $shape = $slide.Shapes.AddShape(1, 80, 80, 480, 220)
  $shape.Fill.ForeColor.RGB = 3368703
  $shape.TextFrame.TextRange.Text = 'Orca visual preview smoke test'
  $presentation.SaveAs($OutputPath, 24)
} finally {
  if ($presentation -ne $null) { $presentation.Close() }
  if ($powerPoint -ne $null) { $powerPoint.Quit() }
  if ($presentation -ne $null) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
  if ($powerPoint -ne $null) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint) }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
`

runPowerPointIntegration(
  'flattens a visual slide through installed PowerPoint',
  async () => {
    const shortDirectory = await mkdtemp(join(tmpdir(), 'orca-pptx-integration-'))
    const directory = await realpath(shortDirectory)
    try {
      const sourcePath = join(directory, 'visual-source.pptx')
      const scriptPath = join(directory, 'create-visual-source.ps1')
      await writeFile(scriptPath, CREATE_VISUAL_DECK_SCRIPT)
      await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          '-OutputPath',
          sourcePath
        ],
        { timeout: 60_000, windowsHide: true }
      )
      const source = await readFile(sourcePath)

      const result = await renderNativePowerPointPreview({
        contentBase64: source.toString('base64'),
        requestToken: 'integration-preview'
      })

      expect(result.status).toBe('rendered')
      if (result.status !== 'rendered') {
        return
      }
      const archive = await JSZip.loadAsync(Buffer.from(result.contentBase64, 'base64'))
      expect(Object.keys(archive.files)).toContain('ppt/media/image1.png')
      expect(
        Object.keys(archive.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
      ).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  300_000
)
