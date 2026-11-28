import { runProtectedJournalService } from '../../../src/main/native-chat/agent-session-journal/protected-journal-service'
import { publishPending } from './export-page.mjs'

const root = '/private/var/orca-committed-journal'
let scheduled = false
function publish() {
  if (scheduled) {
    return
  }
  scheduled = true
  setImmediate(() => {
    try {
      const page = publishPending({
        database: `${root}/profile/agent-session-domain.db`,
        directory: `${root}/export`,
        key: `${root}/identity/signing.pem`,
        checkpoint: `${root}/profile/published.cursor`
      })
      if (page.through - page.after === 8) {
        scheduled = false
        publish()
        return
      }
    } catch {
      console.error('Committed export pending; retry on the next commit or host restart.')
    }
    scheduled = false
  })
}
void runProtectedJournalService(publish).catch(() => {
  console.error('Protected journal service refused its configuration or connection.')
  process.exitCode = 1
})
