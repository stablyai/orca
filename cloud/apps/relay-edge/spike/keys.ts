// Test-only keys for the spike (spike/.keys.json, gitignored). Never real secrets.
//   tsx spike/keys.ts jwks           -> public JWKS (pipe into `wrangler secret put RELAY_JWKS`)
//   tsx spike/keys.ts resume-hashes  -> stub phone credential hash list (SPIKE_RESUME_TOKEN_HASHES)
//   tsx spike/keys.ts dev-vars       -> writes .dev.vars for local `wrangler dev --env spike`
import { writeFileSync } from 'node:fs'
import { jwksOf, loadOrCreateKeys, resumeHashesOf } from './lib'

const keys = await loadOrCreateKeys()
const cmd = process.argv[2] ?? 'jwks'
if (cmd === 'jwks') { process.stdout.write(jwksOf(keys)) }
else if (cmd === 'resume-hashes') { process.stdout.write(resumeHashesOf(keys)) }
else if (cmd === 'dev-vars') {
  writeFileSync(
    new URL('../.dev.vars', import.meta.url),
    `${[`RELAY_JWKS='${jwksOf(keys)}'`, `SPIKE_RESUME_TOKEN_HASHES=${resumeHashesOf(keys)}`, 'SPIKE_ADMIN=1'].join('\n')  }\n`
  )
  console.log('wrote .dev.vars')
} else {
  console.error(`unknown command ${cmd}`)
  process.exitCode = 2
}
