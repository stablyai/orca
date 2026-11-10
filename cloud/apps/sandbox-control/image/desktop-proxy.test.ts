// The remote desktop's ticket + origin gate (vm/orca-desktop-proxy), exercised in python3 with a
// stub websockify. The real thing runs on a VM in the W3 desktop e2e (see the w3-desktop report).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const proxy = fileURLToPath(new URL('./vm/orca-desktop-proxy', import.meta.url).href)
const hasPython = spawnSync('python3', ['--version']).status === 0

function runPython(body: string): { status: number | null; stdout: string; stderr: string } {
  const stub = mkdtempSync(join(tmpdir(), 'orca-desktop-proxy-'))
  mkdirSync(join(stub, 'websockify'))
  writeFileSync(join(stub, 'websockify', '__init__.py'), '')
  writeFileSync(join(stub, 'websockify', 'websocketproxy.py'), 'class ProxyRequestHandler:\n    pass\n')
  const prelude = [
    'import importlib.machinery, importlib.util, os, sys, tempfile, hashlib',
    `loader = importlib.machinery.SourceFileLoader('proxy', ${JSON.stringify(proxy)})`,
    'spec = importlib.util.spec_from_loader("proxy", loader)',
    'p = importlib.util.module_from_spec(spec); loader.exec_module(p)',
    'd = tempfile.mkdtemp()',
    'def mint(t, expires):',
    '    open(os.path.join(d, hashlib.sha256(t.encode()).hexdigest()), "w").write(str(expires))',
    ''
  ].join('\n')
  const run = spawnSync('python3', ['-c', `${prelude}\n${body}`], {
    env: { ...process.env, PYTHONPATH: stub, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8'
  })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

describe.skipIf(!hasPython)('orca-desktop-proxy', () => {
  it('admits a ticket once, before it expires, and never a malformed one', () => {
    const run = runPython(
      [
        'T = "A" * 43; U = "B" * 43; X = "C" * 43',
        'mint(T, 2000); mint(U, 2000); mint(X, 999)',
        'print(p.consume_ticket(d, T, now=1000))', // fresh
        'print(p.consume_ticket(d, T, now=1000))', // replay
        'print(p.consume_ticket(d, X, now=1000))', // expired
        'print(p.consume_ticket(d, X, now=1000))', // and it was still spent
        'print(p.consume_ticket(d, "B" * 42, now=1000))', // malformed
        'print(p.consume_ticket(d, "../" + "B" * 40, now=1000))', // path tricks never reach the disk
        'print(p.consume_ticket(d, U, now=1000))',
        'print(sorted(os.listdir(d)))'
      ].join('\n')
    )
    expect(run.stderr).toBe('')
    expect(run.stdout.trim().split('\n')).toEqual(['True', 'False', 'False', 'False', 'False', 'False', 'True', '[]'])
  })

  it('wants the page and the WebSocket on one localhost origin', () => {
    const run = runPython(
      [
        'cases = [',
        '  ({"Host": "localhost:6081", "Origin": "http://localhost:6081"}, True),',
        '  ({"Host": "127.0.0.1:6091", "Origin": "http://127.0.0.1:6091"}, True),',
        '  ({"Host": "localhost:6081", "Origin": "http://localhost:3000"}, False),',
        '  ({"Host": "localhost:6081", "Origin": "http://evil.example"}, False),',
        '  ({"Host": "localhost:6081"}, False),',
        '  ({"Host": "evil.example:6081", "Origin": "http://evil.example:6081"}, False),',
        '  ({"Host": "localhost.evil.example", "Origin": "http://localhost.evil.example"}, False),',
        '  ({"Host": "localhost:6081", "Origin": "https://localhost:6081"}, False),',
        ']',
        'print(all(p.same_loopback_origin(h) == want for h, want in cases))'
      ].join('\n')
    )
    expect(run.stderr).toBe('')
    expect(run.stdout.trim()).toBe('True')
  })

  it('scrubs tickets from anything it logs', () => {
    const run = runPython('print(p.scrub("GET /websockify?ticket=SECRETSECRET&x=1 HTTP/1.1"))')
    expect(run.stdout.trim()).toBe('GET /websockify?ticket=<redacted>&x=1 HTTP/1.1')
  })
})
