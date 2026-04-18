import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
describe('packaged Windows CLI launcher asset', () => {
    it('walks from resources/bin back to the app root before locating Orca.exe', () => {
        const launcherPath = join(process.cwd(), 'resources', 'win32', 'bin', 'orca.cmd');
        const launcher = readFileSync(launcherPath, 'utf8');
        expect(launcher).toContain('for %%I in ("%RESOURCES_DIR%\\..") do set "APP_DIR=%%~fI"');
        expect(launcher).not.toContain('for %%I in ("%RESOURCES_DIR%..") do set "APP_DIR=%%~fI"');
    });
});
