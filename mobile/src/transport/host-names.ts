type HostNameSource = {
  readonly name: string
}

/** The generated "Host N" shape; a stored name matching it was never typed by the user. */
export const GENERATED_HOST_NAME_PATTERN = /^Host (\d+)$/

export function getNextHostNameFromHosts(hosts: readonly HostNameSource[]): string {
  let largestHostNumber = 0

  for (const host of hosts) {
    const match = GENERATED_HOST_NAME_PATTERN.exec(host.name)
    if (!match) {
      continue
    }

    const hostNumber = Number.parseInt(match[1]!, 10)
    if (hostNumber > largestHostNumber) {
      largestHostNumber = hostNumber
    }
  }

  return `Host ${largestHostNumber + 1}`
}
