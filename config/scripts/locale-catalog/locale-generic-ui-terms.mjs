// Translate ordinary UI vocabulary; pin product-name homonyms (Continue.dev/agent entries) by catalog-key prefixes, not words.

// Valid translations must survive brand repair; nonsense homonyms (回购/端子/Comprometerse) remain in BRAND_MISTRANSLATIONS.
const GENERIC_TERM_FAMILIES = [
  {
    terms: ['Agent', 'Agents', 'agent', 'agents'],
    renderings: {
      ko: ['에이전트'],
      ja: ['エージェント'],
      zh: ['代理', '智能体'],
      es: ['Agente', 'agente', 'Agentes', 'agentes']
    }
  },
  {
    terms: ['Commit', 'Commits', 'commit', 'commits'],
    renderings: {
      ko: ['커밋'],
      ja: ['コミット'],
      zh: ['提交'],
      es: [
        'Confirmación',
        'confirmación',
        'Confirmaciones',
        'confirmaciones',
        'Confirmar',
        'confirmar'
      ]
    }
  },
  {
    terms: ['Continue'],
    // Why: Continue is also a product name, so English "Continue" in translated copy can be right.
    glossary: false,
    renderings: {
      ko: ['계속하다', '계속'],
      ja: ['続ける', '続行'],
      zh: ['继续'],
      es: ['Continuar', 'continuar']
    }
  },
  {
    terms: [
      'Repo',
      'Repos',
      'repo',
      'repos',
      'Repository',
      'Repositories',
      'repository',
      'repositories'
    ],
    renderings: {
      ko: ['저장소', '레포'],
      ja: ['リポジトリ', 'リポ'],
      zh: ['存储库', '仓库'],
      es: ['Repositorio', 'repositorio', 'Repositorios', 'repositorios']
    },
    variants: {
      ko: ['리포지토리']
    }
  },
  {
    terms: ['Source Control', 'source control'],
    renderings: {
      ko: ['소스 제어']
    }
  },
  {
    terms: ['Terminal', 'Terminals', 'terminal', 'terminals'],
    renderings: {
      ko: ['터미널'],
      ja: ['ターミナル'],
      zh: ['终端'],
      es: ['Terminales', 'terminales']
    }
  }
]

// Locales whose catalogs fail verification when copy keeps a glossary term in English; add one once its catalog is clean.
const GLOSSARY_LOCALES = new Set(['ko'])

// The first rendering is the settled one; `variants` are native spellings the glossary replaces with it.
export function glossaryRules(locale) {
  if (!GLOSSARY_LOCALES.has(locale)) {
    return []
  }
  return GENERIC_TERM_FAMILIES.filter(
    (family) => family.glossary !== false && family.renderings[locale]
  ).map((family) => ({
    terms: family.terms,
    rendering: family.renderings[locale][0],
    variants: family.variants?.[locale] ?? []
  }))
}

export const LOCALIZABLE_GENERIC_TERMS = new Set(
  GENERIC_TERM_FAMILIES.flatMap((family) => family.terms)
)

const RENDERINGS_BY_TERM = new Map(
  GENERIC_TERM_FAMILIES.flatMap((family) => family.terms.map((term) => [term, family.renderings]))
)

export function isLocalizableGenericTerm(term) {
  return LOCALIZABLE_GENERIC_TERMS.has(term)
}

export function isCanonicalGenericRendering(term, locale, form) {
  return RENDERINGS_BY_TERM.get(term)?.[locale]?.includes(form) ?? false
}

export function canonicalGenericRenderings(locale) {
  return GENERIC_TERM_FAMILIES.flatMap((family) =>
    (family.renderings[locale] ?? []).map((form) => ({ form, terms: family.terms }))
  )
}

function spansOf(value, needle) {
  const spans = []
  for (let at = value.indexOf(needle); at !== -1; at = value.indexOf(needle, at + 1)) {
    spans.push([at, at + needle.length])
  }
  return spans
}

// Why: zh 终端子进程 ("terminal sub-process") contains 端子, so a blind revert of the
// electrical-connector mistranslation would cut a valid word in half.
export function overlapsCanonicalRendering(term, locale, value, start, end) {
  const renderings = RENDERINGS_BY_TERM.get(term)?.[locale] ?? []
  return renderings.some((form) =>
    spansOf(value, form).some(([from, to]) => start < to && from < end)
  )
}
