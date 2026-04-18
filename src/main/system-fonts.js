import { execFile } from 'child_process';
let cachedFonts = null;
let fontsPromise = null;
export async function listSystemFontFamilies() {
    if (cachedFonts) {
        return cachedFonts;
    }
    if (fontsPromise) {
        return fontsPromise;
    }
    fontsPromise = loadSystemFontFamilies()
        .then((fonts) => {
        cachedFonts = fonts.length > 0 ? fonts : fallbackFonts();
        return cachedFonts;
    })
        .catch(() => {
        cachedFonts = fallbackFonts();
        return cachedFonts;
    })
        .finally(() => {
        fontsPromise = null;
    });
    return fontsPromise;
}
export function warmSystemFontFamilies() {
    void listSystemFontFamilies();
}
function loadSystemFontFamilies() {
    if (process.platform === 'darwin') {
        return listMacFonts();
    }
    if (process.platform === 'win32') {
        return listWindowsFonts();
    }
    return listLinuxFonts();
}
function listMacFonts() {
    return execFileText('system_profiler', ['SPFontsDataType', '-json'], 32 * 1024 * 1024).then((output) => {
        const parsed = JSON.parse(output);
        return uniqueSorted((parsed.SPFontsDataType ?? []).flatMap((font) => (font.typefaces ?? []).map((typeface) => typeface.family)));
    });
}
function listLinuxFonts() {
    return execFileText('fc-list', [':', 'family'], 8 * 1024 * 1024).then((output) => uniqueSorted(output
        .split('\n')
        .flatMap((line) => line.split(','))
        .map((name) => name.trim())
        .filter(Boolean)));
}
function listWindowsFonts() {
    const script = `
Add-Type -AssemblyName System.Drawing
$fonts = New-Object System.Drawing.Text.InstalledFontCollection
$fonts.Families | ForEach-Object { $_.Name }
`;
    return execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 8 * 1024 * 1024).then((output) => uniqueSorted(output
        .split('\n')
        .map((name) => name.trim())
        .filter(Boolean)));
}
function execFileText(command, args, maxBuffer) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { encoding: 'utf8', maxBuffer }, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}
function uniqueSorted(values) {
    return Array.from(new Set(values
        .map((value) => value?.trim() ?? '')
        .filter((value) => value.length > 0 && !value.startsWith('.')))).sort((a, b) => a.localeCompare(b));
}
function fallbackFonts() {
    if (process.platform === 'darwin') {
        return ['SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code'];
    }
    if (process.platform === 'win32') {
        return ['Cascadia Mono', 'Consolas', 'Lucida Console', 'JetBrains Mono', 'Fira Code'];
    }
    return [
        'JetBrains Mono',
        'Fira Code',
        'DejaVu Sans Mono',
        'Liberation Mono',
        'Ubuntu Mono',
        'Noto Sans Mono'
    ];
}
