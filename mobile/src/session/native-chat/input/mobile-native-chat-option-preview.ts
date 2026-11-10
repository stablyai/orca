import { Platform } from 'react-native'
import { typography } from '../../../theme/mobile-theme'

export const optionPreviewFont = Platform.select({
  ios: 'Menlo',
  default: typography.monoFamily
})

// Match terminal columns while expanding tabs in both the measurement and the drawing.
export function prepareOptionPreview(preview: string): { lines: string[]; columns: number } {
  let columns = 1
  const lines = preview
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      let column = 0
      const text: string[] = []
      for (const character of line) {
        if (character === '\t') {
          const spaces = 4 - (column % 4)
          text.push(' '.repeat(spaces))
          column += spaces
        } else {
          text.push(character)
          if (!/\p{Mark}/u.test(character) && character !== '\u200d' && character !== '\ufe0f') {
            column +=
              /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(
                character
              )
                ? 2
                : 1
          }
        }
      }
      columns = Math.max(columns, column)
      return text.join('')
    })
  return { lines, columns }
}
