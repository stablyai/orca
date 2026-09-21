function hasGhHostnameFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--hostname' || arg.startsWith('--hostname='))
}

function hostQualifiedGhRepoValue(value: string, host: string): string {
  // URLs and already-qualified HOST/OWNER/REPO values pass through untouched.
  if (value.includes('://') || value.split('/').length !== 2) {
    return value
  }
  return `${host}/${value}`
}

/**
 * Host-qualify a gh invocation from `options.host`: `--hostname` for `api`
 * calls, `HOST/OWNER/REPO` for `--repo`/`-R` shorthand. SSH-backed repos run
 * gh with no cwd, so this is their only host signal (#8312).
 *
 * @internal exported for tests.
 */
export function applyGhHostToArgs(args: string[], host?: string): string[] {
  if (!host) {
    return args
  }
  let result = args
  if (result[0] === 'api' && !hasGhHostnameFlag(result)) {
    result = ['api', '--hostname', host, ...result.slice(1)]
  }
  // Why: bare OWNER/REPO shorthand resolves against gh's default host — GH_HOST
  // when set — so github.com must be qualified too, not just GHES, or a
  // process-level GH_HOST redirects pinned github.com commands.
  // Combined short forms (`-Ra/b`, `-R=a/b`) are deliberately not rewritten:
  // no call site uses them, and prefix-matching `-R` corrupts free-text values
  // of other flags (e.g. a --title that happens to start with `-R`).
  const qualified: string[] = []
  for (let i = 0; i < result.length; i += 1) {
    const arg = result[i]
    if (arg === '--repo' || arg === '-R') {
      qualified.push(arg)
      const value = result[i + 1]
      if (value !== undefined) {
        qualified.push(hostQualifiedGhRepoValue(value, host))
        i += 1
      }
      continue
    }
    if (arg.startsWith('--repo=')) {
      qualified.push(`--repo=${hostQualifiedGhRepoValue(arg.slice('--repo='.length), host)}`)
      continue
    }
    qualified.push(arg)
  }
  return qualified
}

export function explicitGhHostname(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--hostname') {
      const value = args[i + 1]?.trim()
      return value || undefined
    }
    if (args[i].startsWith('--hostname=')) {
      const value = args[i].slice('--hostname='.length).trim()
      return value || undefined
    }
  }
  return undefined
}

export function explicitGhRepoHostname(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    let value: string | undefined
    if (args[i] === '--repo' || args[i] === '-R') {
      value = args[i + 1]
    } else if (args[i].startsWith('--repo=')) {
      value = args[i].slice('--repo='.length)
    }
    const parts = value?.trim().split('/')
    if (parts?.length === 3 && parts.every(Boolean)) {
      return parts[0]
    }
  }
  return undefined
}

/** Every host named in argv (`--hostname`, `--repo HOST/OWNER/REPO`, attached `-R…`), lowercased. */
export function collectGhArgvHostSignals(args: readonly string[]): string[] {
  const hosts: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--hostname') {
      const value = args[i + 1]?.trim()
      if (value) {
        hosts.push(value.toLowerCase())
      }
      continue
    }
    if (args[i].startsWith('--hostname=')) {
      const value = args[i].slice('--hostname='.length).trim()
      if (value) {
        hosts.push(value.toLowerCase())
      }
      continue
    }
    let repoValue: string | undefined
    if (args[i] === '--repo' || args[i] === '-R') {
      repoValue = args[i + 1]
    } else if (args[i].startsWith('--repo=')) {
      repoValue = args[i].slice('--repo='.length)
    } else if (args[i].startsWith('-R=')) {
      repoValue = args[i].slice('-R='.length)
    } else if (args[i].startsWith('-R') && args[i].length > 2 && !args[i].startsWith('-R-')) {
      // Why: gh accepts attached `-Rhost/owner/repo`; reject host drift on bound calls.
      repoValue = args[i].slice(2)
    }
    const parts = repoValue?.trim().split('/')
    if (parts?.length === 3 && parts.every(Boolean)) {
      hosts.push(parts[0].toLowerCase())
    }
  }
  return hosts
}
