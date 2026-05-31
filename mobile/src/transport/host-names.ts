type HostNameSource = {
  readonly name: string
}

const HOST_NUMBER_PATTERN = /^Host (\d+)$/

export function getNextHostNameFromHosts(hosts: readonly HostNameSource[]): string {
  let largestHostNumber = 0

  for (const host of hosts) {
    const match = HOST_NUMBER_PATTERN.exec(host.name)
    if (!match) continue

    const hostNumber = Number.parseInt(match[1]!, 10)
    if (hostNumber > largestHostNumber) {
      largestHostNumber = hostNumber
    }
  }

  return `Host ${largestHostNumber + 1}`
}
