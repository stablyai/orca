import { createInterface } from 'node:readline'
import {
  initializeProfileLifetimeAdmission,
  readCurrentProfileLifetimeParticipation
} from './profile-lifetime-admission'
import { retainProfileLifetimeSuccessorAuthority } from './profile-lifetime-successor-authority'
import {
  prepareOrcadLiveProfileParticipation,
  retainOrcadLiveProfileParticipation
} from './orcad-live-profile-participation'
import { retainOrcadLiveSuccessorProfileAuthority } from './orcad-live-successor-profile-authority'
import { OrcadLiveCutoverIntentStore } from './orcad-live-cutover-intent-store'
import { selectOrcadLiveResumeAuthority } from './orcad-live-resume-authority-selection'

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
console.log(
  JSON.stringify({ state: 'acquired', participation: readCurrentProfileLifetimeParticipation() })
)
if (mode !== 'probe') {
  let assertSuccessor: (() => void) | undefined
  const input = createInterface({ input: process.stdin })
  input.on('line', (line) => {
    if (line.startsWith('migration-prepare ')) {
      try {
        const intent = JSON.parse(line.slice('migration-prepare '.length))
        prepareOrcadLiveProfileParticipation({
          profileDirectory: profile,
          intent,
          assertAuthority: () => {
            readCurrentProfileLifetimeParticipation()
          }
        })!()
        new OrcadLiveCutoverIntentStore(profile).persist(intent)
        const selected = selectOrcadLiveResumeAuthority(profile, intent)
        selected.assertCurrent()
        console.log(JSON.stringify({ state: 'migration-prepared', mode: selected.mode }))
      } catch (error) {
        console.log(JSON.stringify({ state: 'migration-prepare-refused', error: String(error) }))
      }
    } else if (line.startsWith('migration-successor ')) {
      try {
        const intent = JSON.parse(line.slice('migration-successor '.length))
        assertSuccessor = retainOrcadLiveSuccessorProfileAuthority(profile, intent)
        const selected = selectOrcadLiveResumeAuthority(profile, intent)
        const assertNative = assertSuccessor
        assertSuccessor = () => {
          assertNative()
          selected.assertCurrent()
        }
        assertSuccessor()
        let ordinaryRefused = false
        try {
          retainOrcadLiveProfileParticipation(profile, intent)!()
        } catch {
          ordinaryRefused = true
        }
        console.log(
          JSON.stringify({
            state: 'migration-successor-retained',
            ordinaryRefused,
            mode: selected.mode
          })
        )
      } catch (error) {
        console.log(JSON.stringify({ state: 'migration-successor-refused', error: String(error) }))
      }
    } else if (line.startsWith('successor ')) {
      try {
        assertSuccessor = retainProfileLifetimeSuccessorAuthority(JSON.parse(line.slice(10)))
        console.log(JSON.stringify({ state: 'successor-retained' }))
      } catch (error) {
        console.log(JSON.stringify({ state: 'successor-refused', error: String(error) }))
      }
    } else if (line === 'check') {
      try {
        if (!assertSuccessor) {
          throw new Error('successor_not_retained')
        }
        assertSuccessor()
        console.log(JSON.stringify({ state: 'successor-current' }))
      } catch (error) {
        console.log(JSON.stringify({ state: 'successor-lost', error: String(error) }))
      }
    } else if (line === 'exit') {
      input.close()
      process.stdin.destroy()
    }
  })
}
