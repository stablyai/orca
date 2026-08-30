import { defineConfig, defineDocs, frontmatterSchema } from 'fumadocs-mdx/config'
import { z } from 'zod'

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: frontmatterSchema.extend({
      keywords: z.array(z.string()).optional()
    })
  }
})

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [],
    rehypePlugins: []
  }
})
