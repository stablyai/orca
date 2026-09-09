/**
 * `office.render` — one self-contained HTML snapshot of a document, produced on the host that
 * owns it.
 *
 * The output is written to a host temp file, read back and deleted. It is returned as bytes, not
 * as a path, because the client serves it from memory under an `inline` preview grant: a
 * runtime-owned grant reads through the worktree-scoped `files.read` RPC, so a file-backed answer
 * would have to be written inside the reader's working tree and would show up in their git status.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OFFICE_RENDER_MAX_BYTES,
  OFFICE_RENDER_TIMEOUT_MS,
  officeFailure,
  type OfficeRenderOutcome
} from '../../shared/office-preview-contracts'
import { isOfficeRenderable, officeDocKind } from '../../shared/office-file-extensions'
import { runWslProcess } from '../wsl/wsl-runner'
import { canonicalOfficeDocumentPath, OfficeDocumentPathError } from './office-document-path'
import {
  classifyOfficecliRun,
  classifyOfficeThrown,
  officecliRunSucceeded
} from './office-error-codes'
import { officecliRenderArgs } from './officecli-argv'
import { NATIVE_OFFICECLI_LANE, type OfficecliLane } from './officecli-lane'
import { runOfficecli } from './officecli-invocation'

/** Read cap with headroom: the run is refused above the transport cap, not truncated to it. */
const READ_BUDGET_BYTES = OFFICE_RENDER_MAX_BYTES + 1

type RenderScratch = {
  /** Path the lane's own `officecli` writes to. */
  outputPath: string
  read: () => Promise<string>
  cleanup: () => Promise<void>
}

async function nativeScratch(): Promise<RenderScratch> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-office-'))
  const outputPath = join(directory, 'document.html')
  return {
    outputPath,
    read: async () => {
      const info = await stat(outputPath)
      if (info.size > OFFICE_RENDER_MAX_BYTES) {
        throw new OfficeRenderTooLargeError(info.size)
      }
      return readFile(outputPath, 'utf8')
    },
    cleanup: () => rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

async function wslScratch(distro: string | undefined): Promise<RenderScratch> {
  const made = await runWslProcess({
    script: 'mktemp -d -t orca-office-XXXXXX',
    distro,
    loginPath: 'none',
    timeoutMs: 10_000
  })
  const directory = made.stdout.split(/\r?\n/).find((line) => line.startsWith('/'))
  if (!directory) {
    throw new Error('Could not create a temporary directory in the WSL guest')
  }
  const outputPath = `${directory}/document.html`
  return {
    outputPath,
    read: async () => {
      const sized = await runWslProcess({
        script: 'wc -c < "$1"',
        args: [outputPath],
        distro,
        loginPath: 'none',
        timeoutMs: 10_000
      })
      const size = Number(sized.stdout.trim())
      if (Number.isFinite(size) && size > OFFICE_RENDER_MAX_BYTES) {
        throw new OfficeRenderTooLargeError(size)
      }
      const read = await runWslProcess({
        script: 'cat -- "$1"',
        args: [outputPath],
        distro,
        loginPath: 'none',
        timeoutMs: 30_000,
        maxOutputBytes: READ_BUDGET_BYTES
      })
      return read.stdout
    },
    cleanup: async () => {
      await runWslProcess({
        script: 'rm -rf -- "$1"',
        args: [directory],
        distro,
        loginPath: 'none',
        timeoutMs: 10_000
      }).catch(() => undefined)
    }
  }
}

class OfficeRenderTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`Rendered document is ${bytes} bytes, over the preview cap`)
    this.name = 'OfficeRenderTooLargeError'
  }
}

export async function renderOfficeDocument(
  documentPath: string,
  lane: OfficecliLane = NATIVE_OFFICECLI_LANE
): Promise<OfficeRenderOutcome> {
  const kind = officeDocKind(documentPath)
  if (!kind || !isOfficeRenderable(documentPath)) {
    // Answered before any spawn: a format we do not render must say so itself, never leave the
    // reader looking at an install prompt for a tool that was never the problem.
    return officeFailure('OFFICECLI_UNSUPPORTED_FORMAT')
  }
  let scratch: RenderScratch | null = null
  try {
    const canonicalPath = await canonicalOfficeDocumentPath(documentPath, lane)
    scratch = lane.kind === 'wsl' ? await wslScratch(lane.distro) : await nativeScratch()
    const run = await runOfficecli(officecliRenderArgs(canonicalPath, scratch.outputPath), {
      lane,
      timeoutMs: OFFICE_RENDER_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
    if (!officecliRunSucceeded(run)) {
      return classifyOfficecliRun(run, 'render')
    }
    const html = await scratch.read()
    if (Buffer.byteLength(html, 'utf8') > OFFICE_RENDER_MAX_BYTES) {
      return officeFailure('OFFICE_RENDER_TOO_LARGE')
    }
    return { ok: true, html, kind }
  } catch (error) {
    if (error instanceof OfficeRenderTooLargeError) {
      return officeFailure('OFFICE_RENDER_TOO_LARGE', error.message)
    }
    if (error instanceof OfficeDocumentPathError) {
      return officeFailure('OFFICECLI_FILE_NOT_FOUND', error.message)
    }
    return classifyOfficeThrown(error, 'render')
  } finally {
    await scratch?.cleanup()
  }
}
