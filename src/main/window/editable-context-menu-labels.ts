import { translateMain } from '../i18n/main-i18n'

/** Labels resolve at menu-build time so they follow the current UI language. */
export function editableContextMenuLabels() {
  return {
    addLink: translateMain('auto.main.window.editableContextMenu.addLink', 'Add link'),
    format: translateMain('auto.main.window.editableContextMenu.format', 'Format'),
    bold: translateMain('auto.main.window.editableContextMenu.bold', 'Bold'),
    italic: translateMain('auto.main.window.editableContextMenu.italic', 'Italic'),
    strike: translateMain('auto.main.window.editableContextMenu.strike', 'Strike'),
    inlineCode: translateMain('auto.main.window.editableContextMenu.inlineCode', 'Inline code'),
    codeBlock: translateMain('auto.main.window.editableContextMenu.codeBlock', 'Code block'),
    quote: translateMain('auto.main.window.editableContextMenu.quote', 'Quote'),
    paragraph: translateMain('auto.main.window.editableContextMenu.paragraph', 'Paragraph'),
    bodyText: translateMain('auto.main.window.editableContextMenu.bodyText', 'Body text'),
    heading1: translateMain('auto.main.window.editableContextMenu.heading1', 'Heading 1'),
    heading2: translateMain('auto.main.window.editableContextMenu.heading2', 'Heading 2'),
    heading3: translateMain('auto.main.window.editableContextMenu.heading3', 'Heading 3'),
    heading4: translateMain('auto.main.window.editableContextMenu.heading4', 'Heading 4'),
    heading5: translateMain('auto.main.window.editableContextMenu.heading5', 'Heading 5'),
    bulletList: translateMain('auto.main.window.editableContextMenu.bulletList', 'Bullet list'),
    numberedList: translateMain(
      'auto.main.window.editableContextMenu.numberedList',
      'Numbered list'
    ),
    checklist: translateMain('auto.main.window.editableContextMenu.checklist', 'Checklist'),
    insert: translateMain('auto.main.window.editableContextMenu.insert', 'Insert'),
    link: translateMain('auto.main.window.editableContextMenu.link', 'Link'),
    image: translateMain('auto.main.window.editableContextMenu.image', 'Image'),
    divider: translateMain('auto.main.window.editableContextMenu.divider', 'Divider'),
    paste: translateMain('auto.main.window.editableContextMenu.paste', 'Paste'),
    pasteAsPlainText: translateMain(
      'auto.main.window.editableContextMenu.pasteAsPlainText',
      'Paste as plain text'
    ),
    addToDictionary: translateMain(
      'auto.main.window.editableContextMenu.addToDictionary',
      'Add to dictionary'
    )
  }
}
