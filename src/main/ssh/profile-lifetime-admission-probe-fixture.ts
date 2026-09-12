import { createInterface } from 'node:readline'
import { initializeProfileLifetimeAdmission } from './profile-lifetime-admission'
import { SshConnectionWorkLedger } from './ssh-connection-work-ledger'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'

const [profile, mode, addon] = process.argv.slice(2)
process.env.ORCA_ENABLE_PROFILE_LIFETIME_ADMISSION = '1'
process.env.ORCA_PROFILE_LIFETIME_LOCK_ADDON = addon
try {
  initializeProfileLifetimeAdmission(profile)
} catch (error) {
  if ((error as { code?: string }).code === 'profile_lock_busy') {
    console.log(JSON.stringify({ state: 'busy' }))
    process.exit(0)
  }
  throw error
}
const ledger = new SshConnectionWorkLedger()
console.log(JSON.stringify({ state: 'acquired' }))
if (mode !== 'probe') {
  let written = 0
  const mux = new SshChannelMultiplexer({
    write: () => {
      written++
      return true
    },
    onData: () => {},
    onClose: () => {}
  })
  const input = createInterface({ input: process.stdin })
  input.on('line', (line) => {
    if (line === 'disable') {
      delete process.env.ORCA_ENABLE_PROFILE_LIFETIME_ADMISSION
      console.log(JSON.stringify({ state: 'disabled' }))
    } else if (line === 'admit') {
      void ledger
        .run(async () => {})
        .then(
          () => console.log(JSON.stringify({ state: 'admitted' })),
          () => console.log(JSON.stringify({ state: 'refused' }))
        )
    } else if (line === 'rpc') {
      void mux.request('fixture.work').then(
        () => console.log(JSON.stringify({ state: 'rpc-admitted', written })),
        (error) => console.log(JSON.stringify({ state: 'rpc-refused', written, code: error.code }))
      )
    } else if (line === 'exit') {
      mux.dispose()
      input.close()
      process.stdin.destroy()
    }
  })
}
