import { createInterface } from 'node:readline'
import { spawnProcess } from '@orca/process-host'

// Holds a thread lock the way Codex does: flock on macOS and Linux, LockFileEx on Windows.
export async function holdThreadLock(lock: string): Promise<() => Promise<void>> {
  const windows = process.platform === 'win32'
  const holder = spawnProcess({
    program: windows ? 'powershell.exe' : '/usr/bin/perl',
    args: windows
      ? [
          '-NoProfile',
          '-Command',
          "$l = [IO.File]::Open($env:LOCK, 'OpenOrCreate', 'ReadWrite', 'ReadWrite, Delete'); $l.Lock(0, 1); [Console]::Out.WriteLine('locked'); [void][Console]::In.ReadLine()"
        ]
      : [
          '-MFcntl=:flock',
          '-e',
          'open(my $l, "+>>", $ARGV[0]) or die; flock($l, LOCK_EX) or die; $| = 1; print "locked\\n"; <STDIN>',
          lock
        ],
    env: { ...process.env, LOCK: lock },
    stdio: 'pipe'
  })
  const closed = new Promise((resolve) => holder.once('close', resolve))
  await createInterface({ input: holder.stdout })[Symbol.asyncIterator]().next()
  return async () => {
    holder.stdin.end()
    await closed
  }
}
