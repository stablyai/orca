import { describe, expect, it } from 'vitest'
import { parseRelayDaemonRuntimes } from './ssh-relay-endpoint-runtime'

describe('the runtime each relay daemon runs on', () => {
  it('reads a pinned and a legacy host-Node daemon from their argv', () => {
    const pinned = '/home/dev/.orca-remote/node-runtimes/v24/bin/node'
    const runtimes = parseRelayDaemonRuntimes(
      [
        `${pinned} relay.js --detached --grace-time 0 --sock-path /home/dev/.orca-remote/relay-2/relay-a.sock --credential-file x`,
        '/usr/local/bin/node relay.js --detached --grace-time 300 --sock-path /home/dev/.orca-remote/relay-1/relay-b.sock --log-file y',
        // A bridge client is not a daemon, and a line without a socket is skipped.
        '/usr/bin/node relay.js --connect --sock-path /home/dev/.orca-remote/relay-1/relay-b.sock',
        'grep -F relay.js --detached'
      ].join('\n')
    )
    expect([...runtimes]).toEqual([
      ['/home/dev/.orca-remote/relay-2/relay-a.sock', pinned],
      ['/home/dev/.orca-remote/relay-1/relay-b.sock', '/usr/local/bin/node']
    ])
  })
})
