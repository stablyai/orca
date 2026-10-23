import { plainClassName } from './renderer-scrollbar-style.mjs'

const CHECKS = {
  'no-arbitrary-font-size': {
    pattern: /^text-\[(?:length:)?[\d.]+(?:px|rem|em)\]$/,
    message:
      'Use a chat type step (text-sm, text-xs, text-2xs, text-3xs, text-chat-code), not an arbitrary size. See "Chat type scale" in docs/STYLEGUIDE.md.'
  },
  'no-softened-foreground': {
    pattern: /^text-foreground\/\d+$/,
    message:
      "Don't soften text-foreground by hand: use text-chat-foreground on the chat canvas or text-muted-foreground on a lifted surface. See docs/STYLEGUIDE.md."
  },
  'no-weakened-focus-ring': {
    pattern: /^ring-ring\/\d+$/,
    message:
      'A focus ring at reduced opacity fails 3:1 contrast on the chat canvas: use ring-ring. See docs/STYLEGUIDE.md.'
  }
}

function literalTexts(node) {
  if (node.type === 'Literal') {
    return typeof node.value === 'string' ? [node.value] : []
  }
  return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw)
}

function createRule({ pattern, message }) {
  return {
    create(context) {
      const check = (node) => {
        const offending = literalTexts(node)
          .flatMap((text) => text.split(/\s+/))
          .find((token) => pattern.test(plainClassName(token)))
        if (offending) {
          context.report({ node, message: `${offending}: ${message}` })
        }
      }
      return { Literal: check, TemplateLiteral: check }
    }
  }
}

export default {
  meta: { name: 'native-chat-design-tokens' },
  rules: Object.fromEntries(
    Object.entries(CHECKS).map(([name, check]) => [name, createRule(check)])
  )
}
