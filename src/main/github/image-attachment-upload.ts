import { acquire, extractExecError, ghExecFileAsync, release } from './gh-utils'
import type { GitHubRepoExecution } from './github-api-repository'
import { assertGitHubImage, GitHubImageValidationError } from '../../shared/github/image-attachment'

export async function uploadGitHubImage(args: {
  fileName: string
  contentType: string
  bytes: Buffer
  signal?: AbortSignal
  resolve: (signal: AbortSignal) => Promise<GitHubRepoExecution>
}): Promise<{ url: string }> {
  assertGitHubImage(args.contentType, args.bytes.byteLength)
  const signal = AbortSignal.any([
    AbortSignal.timeout(120_000),
    ...(args.signal ? [args.signal] : [])
  ])
  let admitted = false
  try {
    const { ownerRepo, ghOptions } = await args.resolve(signal)
    signal.throwIfAborted()
    if (!ownerRepo) {
      throw new GitHubImageValidationError(
        'GitHub could not find this repository. Reopen it and try again.'
      )
    }
    const host = ownerRepo.host?.trim().toLowerCase() || 'github.com'
    if (host !== 'github.com' && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com$/.test(host)) {
      throw new GitHubImageValidationError(
        'Image uploads are unavailable on this GitHub server. Attach the image in GitHub or use an image URL.'
      )
    }
    await acquire(signal)
    admitted = true
    const options = { ...ghOptions, signal, idempotent: false, timeout: 120_000 }
    const { stdout } = await ghExecFileAsync(
      ['api', '--cache', '60s', `repos/${ownerRepo.owner}/${ownerRepo.repo}`],
      options
    )
    const repository: { id?: number } = JSON.parse(stdout)
    if (!Number.isSafeInteger(repository.id) || (repository.id ?? 0) <= 0) {
      throw new GitHubImageValidationError(
        'GitHub could not find this repository. Reopen it and try again.'
      )
    }
    const endpoint = new URL(`https://uploads.${host}/user-attachments/assets`)
    endpoint.search = new URLSearchParams({
      name: args.fileName,
      content_type: args.contentType,
      repository_id: String(repository.id)
    }).toString()
    const result = await ghExecFileAsync(
      [
        'api',
        '-X',
        'POST',
        endpoint.href,
        '-H',
        'Content-Type: application/octet-stream',
        '-H',
        `Content-Length: ${args.bytes.byteLength}`,
        '--input',
        '-'
      ],
      { ...options, stdin: args.bytes }
    )
    const asset: { url?: string } = JSON.parse(result.stdout)
    if (!asset.url?.startsWith(`https://${host}/user-attachments/`)) {
      throw new GitHubImageValidationError(
        'GitHub did not return an image URL. Paste the image again to retry.'
      )
    }
    return { url: asset.url }
  } catch (error) {
    if (error instanceof GitHubImageValidationError) {
      throw error
    }
    const { stdout, stderr } = extractExecError(error)
    const message = `${stdout}\n${stderr}`
    if (/\b(?:401|403|404)\b/.test(message)) {
      throw new Error(
        'GitHub could not upload this image with the selected account. Attach it in GitHub or use an image URL.'
      )
    }
    throw new Error(
      signal.aborted
        ? 'The GitHub image upload timed out or was interrupted. Paste the image again to retry.'
        : 'GitHub could not upload this image. Check your connection and paste it again to retry.'
    )
  } finally {
    if (admitted) {
      release()
    }
  }
}
