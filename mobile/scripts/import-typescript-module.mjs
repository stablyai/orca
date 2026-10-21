import * as esbuild from 'esbuild'

/**
 * Imports a TypeScript module from a build script, by bundling it to a data URL.
 *
 * Node cannot import TypeScript and these scripts run outside the app's bundler, so the values the
 * document is built from — the theme, the URL limits, the caret options — would otherwise have to be
 * restated here. Restating them is what the generator exists to avoid.
 */
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
