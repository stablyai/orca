import type { BridgePageHeader } from '../native-capabilities/bridge-page-header'

type HeaderClaim = { header: BridgePageHeader; onAction: (actionId: string) => void }

// The newest claim is the bar the shell draws; releasing it hands the bar to the one beneath, or back to the page.
export function createBridgeClientPageHeader(publish: (header: BridgePageHeader | null) => void) {
  const claims: HeaderClaim[] = []
  const publishTop = () => publish(claims.at(-1)?.header ?? null)
  return {
    accept: (actionId: string) => {
      claims.at(-1)?.onAction(actionId)
    },
    claim: (header: BridgePageHeader, onAction: (actionId: string) => void) => {
      const entry: HeaderClaim = { header, onAction }
      claims.push(entry)
      publishTop()
      const release = () => {
        const index = claims.indexOf(entry)
        if (index === -1) {
          return
        }
        claims.splice(index, 1)
        if (index === claims.length) {
          publishTop()
        }
      }
      return Object.assign(release, {
        update: (next: BridgePageHeader) => {
          if (entry.header === next) {
            return
          }
          entry.header = next
          if (claims.at(-1) === entry) {
            publishTop()
          }
        }
      })
    },
    // A new document's `ready` drops the shell's copy; the page claims again on the `init` that follows.
    reassert: () => {
      if (claims.length > 0) {
        publishTop()
      }
    }
  }
}
