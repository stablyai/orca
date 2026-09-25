import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// Exhaust descriptors in a bounded subprocess so the test runner keeps its own handles.
describe.runIf(process.platform !== 'win32')('descriptor-exhausted ripgrep spawn', () => {
  it('can attach the error listener when a failed spawn has no stdout', () => {
    const script = `
      const { spawn } = require('node:child_process');
      const { openSync, closeSync } = require('node:fs');
      const descriptors = [];
      try { while (true) descriptors.push(openSync('/dev/null', 'r')); } catch {}
      let result;
      try {
        const child = spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe'] });
        result = { hasStdout: Boolean(child.stdout), hasPid: Boolean(child.pid) };
        child.stdout?.setEncoding('utf8');
        child.stderr?.resume();
        child.once('error', (error) => console.log(JSON.stringify({ ...result, code: error.code })));
      } catch (error) {
        result = { code: error.code };
        process.nextTick(() => console.log(JSON.stringify(result)));
      } finally {
        for (const descriptor of descriptors) closeSync(descriptor);
      }
    `
    const output = execFileSync(
      '/bin/sh',
      ['-c', 'ulimit -n 128; exec "$@"', 'sh', process.execPath, '-e', script],
      {
        encoding: 'utf8',
        timeout: 10_000
      }
    )
    expect(JSON.parse(output)).toMatchObject({ code: 'EMFILE' })
  })
})
