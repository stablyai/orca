import { parseHostedRemote } from './hosted-remote-url'
import { parseGitRemoteFetchUrls } from '../../shared/git-remote-url-index'
import { sourceRefsForTarget } from '../../shared/git-branch-cleanup-fetch'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { DEFAULT_BASE_REF_PROBES } from '../../shared/git-default-base-ref'
import { gitExecOptions, type LocalGitExecOptions } from './repo-default-base-ref'
import { gitExecFileAsync } from './runner'

export async function getRemoteFileTarget(
  repoPath: string,
  options: LocalGitExecOptions
): Promise<{ remoteUrl: string; ref: string } | null> {
  const controller = new AbortController()
  const deadline = Date.now() + 5_000
  const timer = setTimeout(() => controller.abort(), 5_000)
  let fallback: { remoteUrl: string; ref: string } | null = null
  const checkpoint = () => {
    if (controller.signal.aborted || Date.now() >= deadline) {
      controller.abort()
      throw new Error('Remote file target deadline exceeded')
    }
  }
  const run = async (argv: string[]): Promise<string> => {
    try {
      checkpoint()
      const { stdout } = await waitForPromiseWithSignal(
        gitExecFileAsync(argv, {
          ...gitExecOptions(repoPath, options),
          signal: controller.signal,
          timeout: Math.max(1, deadline - Date.now()),
          maxBuffer: 1024 * 1024
        }),
        controller.signal
      )
      return stdout
    } catch {
      return ''
    }
  }
  try {
    const urls = parseGitRemoteFetchUrls(await run(['remote', '-v']))
    const mappings = new Map<string, string[]>()
    for (const record of (
      await run(['config', '--null', '--get-regexp', '^remote\\..*\\.fetch$'])
    ).split('\0')) {
      checkpoint()
      const separator = record.indexOf('\n')
      const remote = record.slice(0, separator).match(/^remote\.(.*)\.fetch$/)?.[1]
      if (separator === -1 || !remote) {
        continue
      }
      const specs = mappings.get(remote) ?? []
      specs.push(record.slice(separator + 1))
      mappings.set(remote, specs)
    }
    const target = (remote: string, ref: string) => {
      const remoteUrl = urls.get(remote)
      return remoteUrl && parseHostedRemote(remoteUrl) ? { remoteUrl, ref } : null
    }
    const owners = (ref: string) => {
      const matches: { remote: string; source: string }[] = []
      for (const [remote, specs] of mappings) {
        checkpoint()
        for (const source of sourceRefsForTarget(specs, ref, checkpoint)) {
          matches.push({ remote, source })
          if (matches.length > 1) {
            return matches
          }
        }
      }
      return matches
    }
    const mappedTarget = (ref: string, remote?: string) => {
      const matches = owners(ref)
      const match = matches.length === 1 ? matches[0] : undefined
      return match && (!remote || remote === match.remote) && match.source.startsWith('refs/heads/')
        ? target(match.remote, match.source.slice('refs/heads/'.length))
        : null
    }
    const sha = (await run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
    const branch = (await run(['symbolic-ref', '--quiet', 'HEAD'])).trim()
    const exactPattern = (ref: string) => `${ref.slice(0, -1)}[${ref.slice(-1)}]`
    const refs = new Map<string, string[]>()
    const readExact = async (candidates: string[]) => {
      const requested = new Set(candidates.filter((ref) => ref && !refs.has(ref)))
      const patterns: string[] = []
      for (const ref of requested) {
        checkpoint()
        patterns.push(exactPattern(ref))
      }
      if (!patterns.length) {
        return
      }
      const output = await run([
        'for-each-ref',
        '--format=%(refname)%00%(symref)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)',
        ...patterns
      ])
      for (const row of output.trimEnd().split('\n')) {
        checkpoint()
        const [ref, ...fields] = row.split('\0')
        if (requested.has(ref)) {
          refs.set(ref, fields)
        }
      }
    }
    const defaults: string[] = []
    for (const [remote, url] of urls) {
      checkpoint()
      if (parseHostedRemote(url)) {
        defaults.push(`refs/remotes/${remote}/HEAD`)
      }
    }
    await readExact([branch, ...defaults, ...DEFAULT_BASE_REF_PROBES.map(({ ref }) => ref)])
    const [, upstreamRemote = '', upstreamSource = '', upstreamRef = ''] = refs.get(branch) ?? []
    const preference = [...new Set([upstreamRemote, 'origin', ...urls.keys()])]
    const prepareFallback = () => {
      let selected =
        upstreamRemote !== '.' && refs.has(upstreamRef) && upstreamSource.startsWith('refs/heads/')
          ? target(upstreamRemote, upstreamSource.slice('refs/heads/'.length))
          : null
      for (const remote of ['origin', ...preference.filter((name) => name !== 'origin')]) {
        checkpoint()
        if (selected) {
          break
        }
        const symbolicTarget = refs.get(`refs/remotes/${remote}/HEAD`)?.[0]
        if (symbolicTarget && refs.has(symbolicTarget)) {
          selected = mappedTarget(symbolicTarget, remote)
        }
        if (remote !== 'origin' || selected) {
          continue
        }
        // Preserve legacy origin guesses only under its ordinary branch mapping.
        const ordinary = mappings.get(remote)?.filter((spec) => !spec.startsWith('^'))
        if (
          ordinary?.length !== 1 ||
          ordinary[0].replace(/^\+/, '') !== 'refs/heads/*:refs/remotes/origin/*'
        ) {
          continue
        }
        for (const { ref } of DEFAULT_BASE_REF_PROBES) {
          if (!refs.has(ref)) {
            continue
          }
          const destination = ref.replace('refs/heads/', 'refs/remotes/origin/')
          selected = mappedTarget(destination, remote)
          if (selected) {
            break
          }
        }
      }
      return selected
    }
    fallback = prepareFallback()
    await readExact([upstreamRef, ...defaults.map((ref) => refs.get(ref)?.[0] ?? '')])
    fallback = prepareFallback()
    const destinations = new Set<string>()
    for (const specs of mappings.values()) {
      for (const spec of specs) {
        checkpoint()
        const destination = spec.replace(/^\+/, '').split(':')[1]
        if (!destination?.startsWith('refs/')) {
          continue
        }
        const star = destination.indexOf('*')
        // Refspec captures may cross slashes; Git's query wildcards cannot.
        destinations.add(
          star === -1
            ? exactPattern(destination)
            : destination.slice(0, destination.lastIndexOf('/', star) + 1)
        )
      }
    }
    if (!sha || !destinations.size) {
      return fallback
    }
    const containing = await run([
      'for-each-ref',
      `--contains=${sha}`,
      '--format=%(refname)%00%(symref)',
      ...destinations
    ])
    const published = new Set<string>()
    for (const row of containing.trimEnd().split('\n')) {
      checkpoint()
      const [ref, symbolic] = row.split('\0')
      if (!ref || symbolic) {
        continue
      }
      const matches = owners(ref)
      if (matches.length === 1 && target(matches[0].remote, sha)) {
        published.add(matches[0].remote)
      }
    }
    const remote = preference.find((name) => published.has(name))
    return remote ? target(remote, sha) : fallback
  } catch {
    return fallback
  } finally {
    clearTimeout(timer)
  }
}
