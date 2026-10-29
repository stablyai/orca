import * as esbuild from 'esbuild'

// Bundle TS to a data URL for standalone build scripts so generators reuse app constants rather than restating theme, URL limits and caret options.
export async function importTypeScriptModule(entryPoint) {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent'
  })
  const code = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`)
}
