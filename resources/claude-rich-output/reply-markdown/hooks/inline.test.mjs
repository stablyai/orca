import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inline, holdBold } from './inline.ts'

const punctuation = Array.from({ length: 94 }, (_, index) =>
  String.fromCharCode(index + 33)
).filter((value) => /[^a-z0-9]/i.test(value))
for (const character of punctuation) {
  test(`deletion prose unescapes ASCII punctuation ${JSON.stringify(character)}`, () => {
    assert.deepEqual(inline(`~~old~~ \\${character}`), [
      { mark: 'strike', children: [{ text: 'old' }] },
      { text: ` ${character}` }
    ])
  })
}

test('ordinary backslashes and inline code stay literal in deletion prose', () => {
  const code = '`\\# \\$`'
  assert.deepEqual(inline(`${String.raw`~~old~~ \alpha \1 \中 `}${code}`), [
    { mark: 'strike', children: [{ text: 'old' }] },
    { text: String.raw` \alpha \1 \中 ` },
    { code: String.raw`\# \$` }
  ])
})

for (const delimiter of ['*', '_']) {
  for (const trailing of [' c', '']) {
    test(`italic ${delimiter} retains its nested bold pair with trailing ${JSON.stringify(trailing)}`, () => {
      assert.deepEqual(
        inline(
          `~~x~~ ${delimiter}a ${delimiter.repeat(2)}b${delimiter.repeat(2)}${trailing}${delimiter}`
        ),
        [
          { mark: 'strike', children: [{ text: 'x' }] },
          { text: ' ' },
          {
            mark: 'italic',
            children: [
              { text: 'a ' },
              { mark: 'bold', children: [{ text: 'b' }] },
              ...(trailing ? [{ text: trailing }] : [])
            ]
          }
        ]
      )
    })
  }
}

for (const count of [128, 512]) {
  test(`unclosed deletion markers keep literal text with bounded scanning (${count})`, () => {
    const text = '~~x '.repeat(count)
    const startsWith = String.prototype.startsWith
    let comparisons = 0
    let parsed
    try {
      String.prototype.startsWith = function (...args) {
        comparisons++
        return Reflect.apply(startsWith, this, args)
      }
      parsed = inline(text)
    } finally {
      String.prototype.startsWith = startsWith
    }
    assert.deepEqual(parsed, [{ text }])
    assert.ok(
      comparisons < text.length * 24,
      `${comparisons} comparisons for ${text.length} characters`
    )
  })
}

test('an unmatched dollar line leaves later CJK bold closable', () => {
  assert.equal(holdBold('Before\n$$\n**收斂。**記憶'), 'Before\n$$\n**收斂**。記憶')
})

for (const fence of ['```', '````', '~~~']) {
  test(`CJK bold after an unmatched dollar line preserves a ${fence} literal example`, () => {
    const source = '**literal。**word\n$$'
    const text = `$$\n**收斂。**記憶\n${fence}latex\n${source}\n${fence}\n**最後。**段落`
    assert.equal(
      holdBold(text),
      `$$\n**收斂**。記憶\n${fence}latex\n${source}\n${fence}\n**最後**。段落`
    )
  })
}

test('a closed display formula stays literal while CJK prose after it is closable', () => {
  const formula = '$$\n**literal。**word\n$$'
  assert.equal(holdBold(`${formula}\n**最後。**段落`), `${formula}\n**最後**。段落`)
})

for (const { name, text, parts } of [
  {
    name: 'before',
    text: '~~old~~ text\n\n$$\na = b',
    parts: [{ mark: 'strike', children: [{ text: 'old' }] }, { text: ' text\n\n$$\na = b' }]
  },
  {
    name: 'after',
    text: '$$\na = b\n~~after~~',
    parts: [{ text: '$$\na = b\n' }, { mark: 'strike', children: [{ text: 'after' }] }]
  },
  {
    name: 'both sides',
    text: '~~old~~\n\n$$\n~~new~~',
    parts: [
      { mark: 'strike', children: [{ text: 'old' }] },
      { text: '\n\n$$\n' },
      { mark: 'strike', children: [{ text: 'new' }] }
    ]
  }
]) {
  test(`deletion ${name} an unmatched dollar line retains its inline styling`, () => {
    assert.deepEqual(inline(text), parts)
  })
}

test('a closed display formula keeps deletion examples literal in inline parsing', () => {
  const text = '$$\n~~literal~~\n$$'
  assert.deepEqual(inline(text), [{ text }])
})
