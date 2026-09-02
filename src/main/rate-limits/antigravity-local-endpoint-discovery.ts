import { runProcess } from '../../shared/child-process/run-process'
import { readWindowsProcessTable } from '../windows/windows-process-table'

export type AntigravityEndpoint = {
  port: number
  isHttps: boolean
  csrfToken?: string
}

export function parseCmdLineFlag(cmdLine: string, flag: string): string {
  const needle = `--${flag}`
  let searchFrom = 0
  while (true) {
    const pos = cmdLine.indexOf(needle, searchFrom)
    if (pos === -1) {
      return ''
    }
    const after = pos + needle.length
    const startsToken = pos === 0 || /\s/.test(cmdLine[pos - 1] ?? '')
    const hasSeparator =
      after < cmdLine.length && (cmdLine[after] === '=' || /\s/.test(cmdLine[after] ?? ''))
    if (!startsToken || !hasSeparator) {
      searchFrom = after
      continue
    }
    let valStart = after
    if (cmdLine[valStart] === '=') {
      valStart++
    }
    while (valStart < cmdLine.length && /\s/.test(cmdLine[valStart] ?? '')) {
      valStart++
    }
    if (valStart === cmdLine.length) {
      return ''
    }
    let quote = ''
    if (cmdLine[valStart] === '"' || cmdLine[valStart] === "'") {
      quote = cmdLine[valStart] ?? ''
      valStart++
    }
    let valEnd = valStart
    if (quote) {
      valEnd = cmdLine.indexOf(quote, valStart)
      if (valEnd === -1) {
        return ''
      }
    } else {
      while (valEnd < cmdLine.length && !/\s/.test(cmdLine[valEnd] ?? '')) {
        valEnd++
      }
    }
    return cmdLine.substring(valStart, valEnd)
  }
}

export function parseNetstatListeningPorts(stdout: string, targetPids: Set<number>): number[] {
  const ports: number[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts[0]?.toUpperCase() === 'TCP' && parts[3]?.toUpperCase() === 'LISTENING') {
      const addr = parts[1] ?? ''
      const pid = Number.parseInt(parts[4] ?? '', 10)
      if (targetPids.has(pid)) {
        const portStr = addr.split(':').pop() ?? ''
        const port = Number.parseInt(portStr, 10)
        if (port > 0 && !ports.includes(port)) {
          ports.push(port)
        }
      }
    }
  }
  return ports
}

export function parseLsofListeningPorts(stdout: string, targetPids: Set<number>): number[] {
  const ports: number[] = []
  let currentPid: number | null = null
  for (const line of stdout.split('\n')) {
    if (!line) {
      continue
    }
    if (line.startsWith('p')) {
      const pid = Number.parseInt(line.slice(1), 10)
      currentPid = Number.isFinite(pid) ? pid : null
    } else if (line.startsWith('n') && currentPid !== null && targetPids.has(currentPid)) {
      const addr = line.slice(1)
      const portStr = addr.split(':').pop() ?? ''
      const port = Number.parseInt(portStr, 10)
      if (port > 0 && !ports.includes(port)) {
        ports.push(port)
      }
    }
  }
  return ports
}

export async function discoverAntigravityEndpoints(): Promise<AntigravityEndpoint[]> {
  const endpoints: AntigravityEndpoint[] = []
  const targetPids = new Set<number>()

  if (process.platform === 'win32') {
    try {
      const rows = await readWindowsProcessTable()
      for (const row of rows) {
        const name = (row.name || '').toLowerCase()
        const cmd = (row.command || '').toLowerCase()
        const isMatch =
          name.includes('agy') ||
          name.includes('antigravity') ||
          name.includes('language_server') ||
          name.includes('language-server') ||
          cmd.includes('antigravity')

        if (isMatch) {
          targetPids.add(row.pid)
          const csrf =
            parseCmdLineFlag(row.command, 'csrf_token') ||
            parseCmdLineFlag(row.command, 'csrf-token')
          const serverPortStr =
            parseCmdLineFlag(row.command, 'server_port') ||
            parseCmdLineFlag(row.command, 'server-port') ||
            parseCmdLineFlag(row.command, 'https_server_port') ||
            parseCmdLineFlag(row.command, 'https-server-port')
          const serverPort = Number.parseInt(serverPortStr, 10)
          if (serverPort > 0 && serverPort <= 65535) {
            endpoints.push({ port: serverPort, isHttps: true, csrfToken: csrf })
            endpoints.push({ port: serverPort, isHttps: false, csrfToken: csrf })
          }
        }
      }
    } catch {}

    if (targetPids.size > 0) {
      try {
        const netstatRes = await runProcess({ program: 'netstat', args: ['-ano', '-p', 'tcp'] })
        if (netstatRes.code === 0) {
          const ports = parseNetstatListeningPorts(netstatRes.stdout, targetPids)
          for (const port of ports) {
            endpoints.push({ port, isHttps: false })
            endpoints.push({ port, isHttps: true })
          }
        }
      } catch {}
    }
  } else {
    try {
      const psRes = await runProcess({ program: 'ps', args: ['-eo', 'pid,command'] })
      if (psRes.code === 0) {
        for (const line of psRes.stdout.split('\n')) {
          const trimmed = line.trim()
          const match = trimmed.match(/^(\d+)\s+(.+)$/)
          if (match) {
            const pid = Number.parseInt(match[1] ?? '', 10)
            const cmd = match[2] ?? ''
            const cmdLower = cmd.toLowerCase()
            if (
              cmdLower.includes('agy') ||
              cmdLower.includes('antigravity') ||
              cmdLower.includes('language_server') ||
              cmdLower.includes('language-server')
            ) {
              targetPids.add(pid)
              const csrf =
                parseCmdLineFlag(cmd, 'csrf_token') || parseCmdLineFlag(cmd, 'csrf-token')
              const serverPortStr =
                parseCmdLineFlag(cmd, 'server_port') ||
                parseCmdLineFlag(cmd, 'server-port') ||
                parseCmdLineFlag(cmd, 'https_server_port') ||
                parseCmdLineFlag(cmd, 'https-server-port')
              const serverPort = Number.parseInt(serverPortStr, 10)
              if (serverPort > 0 && serverPort <= 65535) {
                endpoints.push({ port: serverPort, isHttps: true, csrfToken: csrf })
                endpoints.push({ port: serverPort, isHttps: false, csrfToken: csrf })
              }
            }
          }
        }
      }
    } catch {}

    if (targetPids.size > 0) {
      try {
        const lsofRes = await runProcess({
          program: 'lsof',
          args: ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pcn']
        })
        if (lsofRes.code === 0) {
          const ports = parseLsofListeningPorts(lsofRes.stdout, targetPids)
          for (const port of ports) {
            endpoints.push({ port, isHttps: false })
            endpoints.push({ port, isHttps: true })
          }
        }
      } catch {}
    }
  }

  const unique: AntigravityEndpoint[] = []
  const seen = new Set<string>()
  for (const ep of endpoints) {
    const key = `${ep.port}:${ep.isHttps}:${ep.csrfToken ?? ''}`
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(ep)
    }
  }
  return unique
}
