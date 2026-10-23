import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'darwin')(
  'packages both architectures when Swift uses a shared product layout inside each scratch path',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-build-'))
    try {
      const scripts = join(root, 'config', 'scripts')
      const tools = join(root, 'tools')
      await Promise.all([
        mkdir(scripts, { recursive: true }),
        mkdir(tools),
        mkdir(join(root, 'resources', 'build'), { recursive: true })
      ])
      await copyFile(
        resolve('config/scripts/build-computer-macos.mjs'),
        join(scripts, 'build-computer-macos.mjs')
      )
      await writeFile(join(root, 'resources', 'build', 'icon.icns'), 'fixture icon')
      const preamble = `#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';\n`
      await writeFile(
        join(tools, 'swift'),
        `${preamble}const args=process.argv.slice(2);
const scratch=args[args.indexOf('--scratch-path')+1];
if(!args.includes('--scratch-path'))throw new Error('Missing architecture scratch path');
const triple=args[args.indexOf('--triple')+1];
const output=path.join(scratch,'out','Products','Release with spaces');
if(args.includes('--show-bin-path')){console.log(output);process.exit(0)}
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'orca-computer-use-macos'),triple);
`,
        { mode: 0o755 }
      )
      await writeFile(
        join(tools, 'lipo'),
        `${preamble}const args=process.argv.slice(2);
const inputs=args.slice(1,args.indexOf('-output'));
const contents=inputs.map(p=>fs.readFileSync(p,'utf8'));
if(new Set(inputs).size!==2 || new Set(contents).size!==2)throw new Error('Architectures overwritten');
fs.writeFileSync(args[args.indexOf('-output')+1],JSON.stringify(contents));
`,
        { mode: 0o755 }
      )
      await writeFile(join(tools, 'codesign'), preamble, { mode: 0o755 })
      execFileSync(process.execPath, [join(scripts, 'build-computer-macos.mjs')], {
        env: {
          ...process.env,
          PATH: `${tools}:${process.env.PATH}`,
          ORCA_COMPUTER_MACOS_SIGN_IDENTITY: '-'
        },
        stdio: 'pipe',
        timeout: 10_000
      })
      const app = join(
        root,
        'native',
        'computer-use-macos',
        '.build',
        'release',
        'Orca Computer Use.app'
      )
      expect(
        JSON.parse(
          await readFile(join(app, 'Contents', 'MacOS', 'orca-computer-use-macos'), 'utf8')
        )
      ).toEqual(['arm64-apple-macosx', 'x86_64-apple-macosx'])
      expect(await readFile(join(app, 'Contents', 'Info.plist'), 'utf8')).toContain(
        'com.stablyai.orca.computer-use'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
