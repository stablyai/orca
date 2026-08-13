import { platform } from 'os';
import * as childProcess from 'child_process';
if (platform() === 'win32') {
  const conemu = childProcess.spawn('conemu.exe', [], {
  stdio: 'inherit'
});
conemu.on('error', (err) => {
  console.error('Error launching ConEmu:', err);
});
  // existing code
}