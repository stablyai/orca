import { DOMParser } from '@xmldom/xmldom'
import { isSafePluginRelativePath } from '../../../shared/plugins/installation/plugin-path-safety'
import { readContainedPluginArtifactBytes } from '../artifacts/plugin-contained-artifact'

export const PLUGIN_PANEL_SVG_MAX_BYTES = 32 * 1024

export async function readPluginPanelSvg(root: string, path: string): Promise<Buffer> {
  if (!isSafePluginRelativePath(path) || !/\.svg$/i.test(path)) {
    throw new Error('icon must be a plugin-relative .svg path')
  }
  const bytes = await readContainedPluginArtifactBytes(root, path, PLUGIN_PANEL_SVG_MAX_BYTES)
  let invalid = false
  const document = new DOMParser({
    errorHandler: {
      warning: () => {
        invalid = true
      },
      error: () => {
        invalid = true
      },
      fatalError: () => {
        invalid = true
      }
    }
  }).parseFromString(bytes.toString('utf8'), 'image/svg+xml')
  const rootElement = document.documentElement
  if (
    invalid ||
    document.doctype ||
    rootElement?.localName !== 'svg' ||
    !rootElement.getAttribute('viewBox')
  ) {
    throw new Error('icon must be a parseable SVG with a viewBox')
  }
  const nodes = document.getElementsByTagName('*')
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes.item(i)
    if (!node) {
      continue
    }
    if (['script', 'foreignobject'].includes(node.localName.toLowerCase())) {
      throw new Error('icon contains forbidden SVG content')
    }
    for (let j = 0; j < node.attributes.length; j++) {
      const attr = node.attributes.item(j)
      if (
        attr &&
        (/^on/i.test(attr.localName) ||
          (attr.localName.toLowerCase() === 'href' && !attr.value.startsWith('#')))
      ) {
        throw new Error('icon contains forbidden SVG content')
      }
    }
  }
  return bytes
}
