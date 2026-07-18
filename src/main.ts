import { platform } from 'os';
import * as childProcess from 'child_process';
if (platform() === 'win32') {
  childProcess.exec('cmd.exe /c "conemu.exe"');
  // existing code
}