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
    renderings: {
      ko: ['계속하다', '계속'],
      ja: ['続ける', '続行'],
      zh: ['继续'],
      es: ['Continuar', 'continuar']
    }
  },
  {
    terms: ['Repo', 'Repos', 'repo', 'repos'],
    renderings: {
      ko: ['저장소', '레포'],
      ja: ['リポジトリ', 'リポ'],
      zh: ['存储库', '仓库'],
      es: ['Repositorio', 'repositorio', 'Repositorios', 'repositorios']
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
