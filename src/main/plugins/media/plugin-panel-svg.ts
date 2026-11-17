import { SaxesParser } from 'saxes'
import { isSafePluginRelativePath } from '../../../shared/plugins/installation/plugin-path-safety'
import { readContainedPluginArtifactBytes } from '../artifacts/plugin-contained-artifact'

export const PLUGIN_PANEL_SVG_MAX_BYTES = 32 * 1024

function assertLocalSvgReferences(value: string): void {
  const css = value.replace(/\/\*[\s\S]*?\*\//g, '')
  if (css.includes('\\') || css.includes('@') || css.includes('/*') || css.includes('*/')) {
    throw new Error('icon contains forbidden SVG content')
  }
  const urls = /url\s*\(/gi
  for (let match = urls.exec(css); match; match = urls.exec(css)) {
    if (!/^url\s*\(\s*(?:#[\w.:-]+|"#[\w.:-]+"|'#[\w.:-]+')\s*\)/i.test(css.slice(match.index))) {
      throw new Error('icon contains forbidden SVG content')
    }
  }
}

function validatePanelSvg(bytes: Buffer): void {
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('icon must be a parseable SVG with a viewBox')
  }
  const parser = new SaxesParser({ xmlns: true })
  let rootSeen = false
  let styleDepth = 0
  let styleText = ''
  parser.on('doctype', () => {
    throw new Error('icon contains forbidden SVG content')
  })
  parser.on('opentag', (tag) => {
    if (!rootSeen) {
      rootSeen = true
      if (
        tag.local !== 'svg' ||
        tag.uri !== 'http://www.w3.org/2000/svg' ||
        !tag.attributes.viewBox?.value
      ) {
        throw new Error('icon must be a parseable SVG with a viewBox')
      }
    }
    if (['script', 'foreignobject'].includes(tag.local.toLowerCase())) {
      throw new Error('icon contains forbidden SVG content')
    }
    if (tag.local.toLowerCase() === 'style') {
      styleDepth++
    }
    for (const attr of Object.values(tag.attributes)) {
      if (
        /^on/i.test(attr.local) ||
        (attr.local.toLowerCase() === 'href' && !attr.value.startsWith('#'))
      ) {
        throw new Error('icon contains forbidden SVG content')
      }
      assertLocalSvgReferences(attr.value)
    }
  })
  parser.on('text', (text) => {
    if (styleDepth) {
      styleText += text
    }
  })
  parser.on('cdata', (text) => {
    if (styleDepth) {
      styleText += text
    }
  })
  parser.on('closetag', (tag) => {
    if (tag.local.toLowerCase() === 'style') {
      styleDepth--
      if (!styleDepth) {
        assertLocalSvgReferences(styleText)
        styleText = ''
      }
    }
  })
  try {
    parser.write(source).close()
  } catch (error) {
    if (error instanceof Error && error.message === 'icon contains forbidden SVG content') {
      throw error
    }
    throw new Error('icon must be a parseable SVG with a viewBox')
  }
  if (!rootSeen) {
    throw new Error('icon must be a parseable SVG with a viewBox')
  }
}

export async function readPluginPanelSvg(root: string, path: string): Promise<Buffer> {
  if (!isSafePluginRelativePath(path) || !/\.svg$/i.test(path)) {
    throw new Error('icon must be a plugin-relative .svg path')
  }
  const bytes = await readContainedPluginArtifactBytes(root, path, PLUGIN_PANEL_SVG_MAX_BYTES)
  validatePanelSvg(bytes)
  return bytes
}
