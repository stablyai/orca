import { Document, Packer, Paragraph, TextRun } from 'docx'
import * as XLSX from 'xlsx'
import * as fs from 'node:fs'
import * as path from 'node:path'

const FIXTURE_DIR = path.join(
  import.meta.dirname,
  '../src/renderer/src/components/editor/__tests__/fixtures'
)

async function writeDocx(): Promise<void> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun('Hello office preview')]
          }),
          new Paragraph({
            children: [new TextRun('Second paragraph for tab traversal')]
          })
        ]
      }
    ]
  })
  const buffer = await Packer.toBuffer(doc)
  fs.writeFileSync(path.join(FIXTURE_DIR, 'tiny.docx'), buffer)
}

function writeXlsx(): void {
  const wb = XLSX.utils.book_new()
  const sheet1 = XLSX.utils.aoa_to_sheet([
    ['A1', 'B1', 'C1'],
    ['1', '2', '3'],
    ['4', '5', '6']
  ])
  const sheet2 = XLSX.utils.aoa_to_sheet([
    ['x', 'y'],
    ['7', '8']
  ])
  const sheet3 = XLSX.utils.aoa_to_sheet([['only-on-sheet-3']])
  XLSX.utils.book_append_sheet(wb, sheet1, 'First')
  XLSX.utils.book_append_sheet(wb, sheet2, 'Second')
  XLSX.utils.book_append_sheet(wb, sheet3, 'Third')
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  fs.writeFileSync(path.join(FIXTURE_DIR, 'tiny.xlsx'), buffer)
}

function writeEmptyXlsx(): void {
  const wb = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([[]])
  XLSX.utils.book_append_sheet(wb, sheet, 'Empty')
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  fs.writeFileSync(path.join(FIXTURE_DIR, 'empty.xlsx'), buffer)
}

async function main(): Promise<void> {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true })
  await writeDocx()
  writeXlsx()
  writeEmptyXlsx()
  console.log('fixtures written to', FIXTURE_DIR)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
