import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  NativePowerPointPreviewRequest,
  NativePowerPointPreviewResult
} from '../../shared/powerpoint-preview'
import { NATIVE_POWERPOINT_PREVIEW_SCRIPT } from './native-powerpoint-preview-script'

const execFileAsync = promisify(execFile)
const POWERPOINT_EXPORT_TIMEOUT_MS = 180_000
const MINIMUM_PREVIEW_BYTES = 1_000

type NativePowerPointPreviewDependencies = {
  platform: NodeJS.Platform
  createTemporaryDirectory: () => Promise<string>
  createDirectory: (path: string) => Promise<void>
  writeFile: (path: string, content: string | Buffer) => Promise<void>
  readFile: (path: string) => Promise<Buffer>
  removeDirectory: (path: string) => Promise<void>
  runPowerShell: (args: string[], signal?: AbortSignal) => Promise<void>
  terminatePowerPointProcess: (processIdPath: string) => Promise<void>
}

async function terminateRecordedPowerPointProcess(processIdPath: string): Promise<void> {
  try {
    const processIdText = await readFile(processIdPath, 'utf8')
    if (!/^\d+$/.test(processIdText.trim())) {
      return
    }
    process.kill(Number(processIdText.trim()), 'SIGKILL')
  } catch {
    // The export script normally closes PowerPoint before Node needs to clean it up.
  }
}

const defaultDependencies: NativePowerPointPreviewDependencies = {
  platform: process.platform,
  createTemporaryDirectory: async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-pptx-preview-'))
    // Why: Windows can expose %TEMP% through an 8.3 path, which PowerPoint's
    // SaveAs COM method rejects even though regular filesystem APIs accept it.
    return realpath(directory)
  },
  createDirectory: async (path) => {
    await mkdir(path, { recursive: true })
  },
  writeFile,
  readFile,
  removeDirectory: async (path) => {
    await rm(path, { recursive: true, force: true })
  },
  runPowerShell: async (args, signal) => {
    await execFileAsync('powershell.exe', args, {
      timeout: POWERPOINT_EXPORT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      signal
    })
  },
  terminatePowerPointProcess: terminateRecordedPowerPointProcess
}

function unavailable(reason: unknown): NativePowerPointPreviewResult {
  const message = reason instanceof Error ? reason.message : String(reason)
  return { status: 'unavailable', reason: message }
}

export async function renderNativePowerPointPreview(
  request: NativePowerPointPreviewRequest,
  dependencies: NativePowerPointPreviewDependencies = defaultDependencies,
  signal?: AbortSignal
): Promise<NativePowerPointPreviewResult> {
  if (dependencies.platform !== 'win32') {
    return unavailable('Native PowerPoint rendering is only available on Windows.')
  }
  if (!request.contentBase64) {
    return unavailable('The presentation is empty.')
  }

  let temporaryDirectory: string | null = null
  let processIdPath: string | null = null
  try {
    temporaryDirectory = await dependencies.createTemporaryDirectory()
    const inputPath = join(temporaryDirectory, 'source.pptx')
    const outputPath = join(temporaryDirectory, 'preview.pptx')
    const scriptPath = join(temporaryDirectory, 'render-preview.ps1')
    const imageDirectory = join(temporaryDirectory, 'slides')
    processIdPath = join(temporaryDirectory, 'powerpoint.pid')
    await dependencies.createDirectory(imageDirectory)
    await Promise.all([
      dependencies.writeFile(inputPath, Buffer.from(request.contentBase64, 'base64')),
      dependencies.writeFile(scriptPath, NATIVE_POWERPOINT_PREVIEW_SCRIPT)
    ])
    await dependencies.runPowerShell(
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-InputPath',
        inputPath,
        '-OutputPath',
        outputPath,
        '-ImageDirectory',
        imageDirectory,
        '-ProcessIdPath',
        processIdPath
      ],
      signal
    )
    const preview = await dependencies.readFile(outputPath)
    if (preview.byteLength < MINIMUM_PREVIEW_BYTES || preview.subarray(0, 2).toString() !== 'PK') {
      throw new Error('PowerPoint did not create a valid preview presentation.')
    }
    return { status: 'rendered', contentBase64: preview.toString('base64') }
  } catch (error) {
    if (processIdPath) {
      // Why: killing the PowerShell wrapper does not terminate its out-of-process
      // COM server, so cancel/error cleanup targets only the PID created here.
      await dependencies.terminatePowerPointProcess(processIdPath)
    }
    return unavailable(error)
  } finally {
    if (temporaryDirectory) {
      await dependencies.removeDirectory(temporaryDirectory).catch(() => undefined)
    }
  }
}
