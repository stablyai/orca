import { BoundedMap } from '../../shared/bounded-map'
import { extractExecError } from '../git/exec-error'
import { ghExecFileAsync } from './gh-utils'
import { githubReadExecutionScope } from './github-read-execution-scope'
import {
  githubHostExecOptions,
  type GitHubApiRepository,
  type GitHubRepoExecOptions
} from './github-api-repository'
import { noteRepositoryRateLimitSpend } from './rate-limit'

type Representation = { etag: string; body: string }
const representations = new BoundedMap<string, Representation>({
  maxEntries: 512,
  maxBytes: 16 * 1024 * 1024,
  maxEntryBytes: 2 * 1024 * 1024,
  sizeOf: (value, key) =>
    Buffer.byteLength(key) + Buffer.byteLength(value.etag) + Buffer.byteLength(value.body)
})
const latestReads = new Map<string, object>()

function parseResponse(stdout: string): { status: number; etag?: string; body: string } | null {
  const separator = /\r?\n\r?\n/.exec(stdout)
  const status = /^HTTP\/\d+(?:\.\d+)? (\d{3})(?:[^\r\n]*)\r?\n/.exec(stdout)
  if (!separator || !status) {
    return null
  }
  const headers = stdout.slice(0, separator.index)
  const etag = /^etag:[ \t]*([^\r\n]+)/im.exec(headers)?.[1].trim()
  return {
    status: Number(status[1]),
    etag,
    body: stdout.slice(separator.index + separator[0].length)
  }
}

/** Always revalidate: authenticated 304 responses preserve freshness without spending primary quota. */
export async function revalidateGitHubRestJson(
  repository: GitHubApiRepository,
  endpoint: string,
  options: GitHubRepoExecOptions
): Promise<string> {
  const execution = {
    ...options,
    ...githubHostExecOptions(repository)
  }
  const key = JSON.stringify([githubReadExecutionScope(execution), endpoint])
  const token = {}
  latestReads.set(key, token)
  const ownsKey = (): boolean => latestReads.get(key) === token
  const previous = representations.get(key)
  const args = ['api', endpoint, '--include']
  if (previous) {
    args.push('-H', `If-None-Match: ${previous.etag}`)
  }
  try {
    let stdout: string
    try {
      stdout = (await ghExecFileAsync(args, execution)).stdout
    } catch (error) {
      const failed = extractExecError(error).stdout
      if (!failed || parseResponse(failed)?.status !== 304) {
        throw error
      }
      stdout = failed
    }
    const response = parseResponse(stdout)
    if (!response) {
      throw new Error('GitHub REST response is missing HTTP headers')
    }
    if (response.status === 304) {
      if (!previous) {
        throw new Error('GitHub returned HTTP 304 without a cached representation')
      }
      return previous.body
    }
    if (response.status !== 200) {
      throw new Error(`Unexpected GitHub REST response: HTTP ${response.status}`)
    }
    noteRepositoryRateLimitSpend(repository, 'core', 1, execution)
    JSON.parse(response.body)
    if (ownsKey()) {
      representations.delete(key)
      if (response.etag) {
        representations.set(key, { etag: response.etag, body: response.body })
      }
    }
    return response.body
  } catch (error) {
    if (ownsKey()) {
      representations.delete(key)
    }
    throw error
  } finally {
    if (ownsKey()) {
      latestReads.delete(key)
    }
  }
}
