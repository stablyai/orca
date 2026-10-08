import { RipgrepLaunchFailureError } from '../shared/ripgrep-process-availability'
export async function runRelayFileListingPasses(
  options: {
    includeIgnored?: boolean
    searchQuery?: string
    maxResults?: number
    candidatePaths?: string[]
  },
  primary: string[],
  ignoredPass: string[],
  runPass: (args: string[]) => Promise<void>,
  resultCount: () => number
): Promise<void> {
  if (options.includeIgnored === false) {
    return runPass(primary)
  }
  // Unordered candidate checks and ranked scans need only the broader pass.
  if (
    options.candidatePaths !== undefined ||
    options.searchQuery !== undefined ||
    options.maxResults === undefined
  ) {
    return runPass(ignoredPass)
  }
  await runPass(primary)
  if (resultCount() < options.maxResults) {
    await runPass(ignoredPass)
  }
}

export function retryRelayFileListingPass(
  run: () => Promise<void>,
  isCanceled: () => boolean
): Promise<void> {
  return run().catch((error: unknown) => {
    if (!(error instanceof RipgrepLaunchFailureError) || isCanceled()) {
      throw error
    }
    return run()
  })
}
