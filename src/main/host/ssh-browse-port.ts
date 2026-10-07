import type { SshBrowseConnection } from '../ssh/ssh-directory-browse'

type SshBrowseResolver = ((targetId: string) => SshBrowseConnection | undefined) | null

let resolver: SshBrowseResolver = null

export function setSshBrowseConnectionResolver(next: SshBrowseResolver): void {
  resolver = next
}

export function getSshBrowseConnection(targetId: string): SshBrowseConnection | undefined {
  return resolver?.(targetId)
}
