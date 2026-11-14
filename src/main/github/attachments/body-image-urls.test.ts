import { describe, expect, it } from 'vitest'
import { githubBodyImageUrls } from './body-image-urls'

const original = 'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488'
const signed =
  'https://private-user-images.githubusercontent.com/1/2-ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST&download=1'

describe('GitHub body image sources', () => {
  it('matches rendered images to canonical assets without changing editable Markdown', () => {
    const body = `![shot](${original})\n<img src="https://github.enterprise/team/repo/assets/42/ab11040a-fb66-4289-927f-547b16dfc488">\n![missing](https://github.com/user-attachments/assets/cc11040a-fb66-4289-927f-547b16dfc488)\n\`https://github.com/user-attachments/assets/dd11040a-fb66-4289-927f-547b16dfc488\``
    const html = `<img src="https://private-user-images.githubusercontent.com/1/2-ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST&amp;download=1"><img src="https://github.enterprise/storage/ab11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST"><code>https://private-user-images.githubusercontent.com/1/dd11040a-fb66-4289-927f-547b16dfc488.png</code>`
    expect(githubBodyImageUrls(body, html)).toEqual({
      'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488': signed,
      'https://github.enterprise/team/repo/assets/42/ab11040a-fb66-4289-927f-547b16dfc488':
        'https://github.enterprise/storage/ab11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST'
    })
    expect(githubBodyImageUrls(body, undefined)).toBeUndefined()
    expect(githubBodyImageUrls(`![public](${original})`, `<img src="${original}">`)).toBeUndefined()
    expect(
      githubBodyImageUrls(
        body,
        '<img src="https://unrelated.example/ce11040a-fb66-4289-927f-547b16dfc488.png">'
      )
    ).toBeUndefined()
  })
})
