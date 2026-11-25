import type {
  BridgePageHeader,
  BridgePageHeaderContent
} from '../native-capabilities/bridge-page-header'

type HeaderClaim = { header: BridgePageHeaderContent; onAction: (actionId: string) => void }

// The newest claim is the bar the shell draws; releasing it hands the bar to the one beneath, or back to the page.
export function createBridgeClientPageHeader(publish: (header: BridgePageHeader | null) => void) {
  const claims: HeaderClaim[] = []
  // Every send of the top claim's header gets the next one, so the last sent names the header in effect.
  let revision = 0
  const publishTop = () => {
    const top = claims.at(-1)
    revision += 1
    publish(top ? { ...top.header, revision } : null)
  }
  return {
    accept: (actionId: string, pressedRevision: number) => {
      if (pressedRevision === revision) {
        claims.at(-1)?.onAction(actionId)
      }
    },
    claim: (header: BridgePageHeaderContent, onAction: (actionId: string) => void) => {
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
        update: (next: BridgePageHeaderContent) => {
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
