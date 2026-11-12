import { defineConfig, defineDocs, frontmatterSchema } from 'fumadocs-mdx/config'
import { z } from 'zod'
import { docsVersioning } from './versioning.config'

export const docs = defineDocs({
  dir: docsVersioning.current.sourceDir,
  docs: {
    schema: frontmatterSchema.extend({
      keywords: z.array(z.string()).optional()
    })
  }
})

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: {
        light: 'github-light',
        dark: 'github-dark-high-contrast'
      }
    },
    remarkPlugins: [],
    rehypePlugins: []
  }
})
