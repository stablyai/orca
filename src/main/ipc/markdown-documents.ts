import { spawnBundledRipgrep } from '../ripgrep/bundled-ripgrep-spawn'
import { stopBundledRipgrep } from '../ripgrep/bundled-ripgrep-stop'
import { resolveBundledRipgrepWslRouting } from '../ripgrep/bundled-ripgrep-wsl-routing'
import {
  collectMarkdownDocuments,
  MARKDOWN_DOCUMENT_LISTING_ARGS
} from '../../shared/node-markdown-document-listing'
import type { MarkdownDocument } from '../../shared/filesystem-entry-types'
export * from '../../shared/markdown-document-paths'

/**
 * Lists Markdown documents under a native or WSL root, allowing partial results only
 * for ripgrep traversal errors (exit 2) with at least one valid document.
 */
export async function listMarkdownDocuments(
  rootPath: string,
  options: { wslDistro?: string; signal?: AbortSignal } = {}
): Promise<MarkdownDocument[]> {
  options.signal?.throwIfAborted()
  const { wslDistro, wslDistroForOutput: distro } = resolveBundledRipgrepWslRouting(
    rootPath,
    options.wslDistro
  )
  const child = spawnBundledRipgrep(MARKDOWN_DOCUMENT_LISTING_ARGS, {
    cwd: rootPath,
    wslDistro,
    wslDistroForOutput: distro,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return collectMarkdownDocuments(child, rootPath, Boolean(distro), options.signal, {
    allowPartialListing: true,
    stopProcess: () => stopBundledRipgrep(child, Boolean(distro))
  })
}
