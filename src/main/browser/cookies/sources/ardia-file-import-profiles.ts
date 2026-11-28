import { lstat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

type ArdiaProfile = { id: string; name: string }

function isArdiaProfile(value: unknown): value is ArdiaProfile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    'name' in value &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0
  )
}

export async function listArdiaFileImportProfiles(): Promise<ArdiaProfile[]> {
  if (process.platform !== 'darwin') {
    return []
  }
  const path = join(
    homedir(),
    'Library',
    'Application Support',
    'com.ardia.browser',
    'ArdiaControl.sock'
  )
  const stat = await lstat(path).catch(() => null)
  if (!stat?.isSocket() || stat.uid !== process.getuid?.()) {
    return []
  }

  return new Promise((resolve) => {
    const socket = createConnection(path)
    const timer = setTimeout(() => finish([]), 1500)
    let pending = ''
    let waitingForProfiles = false

    function finish(profiles: ArdiaProfile[]): void {
      clearTimeout(timer)
      socket.destroy()
      resolve(profiles)
    }

    socket.once('error', () => finish([]))
    socket.once('close', () => finish([]))
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({
          id: 1,
          method: 'hello',
          params: { caller: { name: 'Orca' }, protocol: 4 }
        })}\n`
      )
    })
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      pending += chunk
      if (pending.length > 1024 * 1024) {
        return finish([])
      }
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        try {
          const reply = JSON.parse(pending.slice(0, newline))
          if (!waitingForProfiles && reply.id === 1) {
            if (reply.result?.app !== 'Ardia') {
              return finish([])
            }
            waitingForProfiles = true
            socket.write('{"id":2,"method":"profiles.list"}\n')
          } else if (waitingForProfiles && reply.id === 2) {
            const profiles: unknown = reply.result
            return finish(
              Array.isArray(profiles)
                ? profiles.filter(isArdiaProfile).map(({ id, name }) => ({ id, name }))
                : []
            )
          }
        } catch {
          return finish([])
        }
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
    })
  })
}
