WITH
  supporting_versions AS (
    SELECT DISTINCT toString(properties.app_version) AS v
    FROM events
    WHERE event IN ('first_agent_interaction', 'meaningful_activity_day')
      AND timestamp >= toDateTime('2026-11-08 00:00:00')
      AND properties.install_id IS NOT NULL AND properties.orca_channel IS NOT NULL
  ),
  opted_out AS (
    SELECT distinct_id AS uid
    FROM events
    WHERE event = 'telemetry_opted_out'
      AND timestamp >= toDateTime('2026-10-09 00:00:00')
      AND properties.install_id IS NOT NULL AND properties.orca_channel IS NOT NULL
    GROUP BY uid
  ),
  anchors AS (
    SELECT
      distinct_id AS uid,
      min(timestamp) AS anchor_at,
      formatDateTime(min(timestamp), '%Y-%m-%d') AS cohort_day,
      argMin(coalesce(toString(properties.platform), 'unknown'), timestamp) AS platform,
      argMin(toString(properties.app_version), timestamp) AS anchor_version
    FROM events
    WHERE event = 'onboarding_started'
      AND properties.cohort = 'fresh_install'
      AND timestamp >= toDateTime('2026-10-09 00:00:00')
      AND properties.install_id IS NOT NULL AND properties.orca_channel IS NOT NULL
    GROUP BY uid
  ),
  cohort AS (
    SELECT uid, anchor_at, cohort_day, platform
    FROM anchors
    WHERE anchor_at >= toDateTime('2026-11-08 00:00:00')
      AND anchor_version IN (SELECT v FROM supporting_versions)
      AND uid NOT IN (SELECT uid FROM opted_out)
  ),
  mature AS (
    SELECT uid, anchor_at, platform FROM cohort
    WHERE anchor_at <= now() - INTERVAL 1455 MINUTE
  ),
  surface AS (
    SELECT m.uid AS uid, 1 AS has_surface, min(e.timestamp) AS surface_at
    FROM events e
    INNER JOIN mature m ON m.uid = e.distinct_id
    WHERE e.timestamp >= toDateTime('2026-11-08 00:00:00')
      AND e.timestamp >= m.anchor_at
      AND e.timestamp < m.anchor_at + INTERVAL 24 HOUR
      AND e.properties.orca_channel IS NOT NULL
      AND (
        e.event = 'workspace_created'
        OR (e.event = 'add_repo_setup_step_action'
          AND toString(e.properties.action) IN ('open_existing', 'open_primary', 'create_worktree'))
        OR (e.event = 'add_repo_default_checkout_handoff'
          AND toString(e.properties.result) = 'opened_default_checkout')
        OR (e.event = 'repo_added' AND toString(e.properties.is_git_repo) = 'false')
      )
    GROUP BY m.uid
  ),
  interaction AS (
    SELECT
      distinct_id AS uid,
      1 AS has_interaction,
      min(timestamp) AS fai_at,
      argMin(coalesce(toString(properties.install_cohort), 'unknown'), timestamp) AS fai_cohort,
      argMin(coalesce(toString(properties.source), 'unknown'), timestamp) AS fai_source
    FROM events
    WHERE event = 'first_agent_interaction'
      AND timestamp >= toDateTime('2026-11-08 00:00:00')
      AND properties.install_id IS NOT NULL AND properties.orca_channel IS NOT NULL
    GROUP BY uid
  ),
  per_install AS (
    SELECT
      m.platform AS platform,
      s.has_surface = 1 AS surface_24h,
      i.has_interaction = 1 AND i.fai_cohort = 'fresh'
        AND i.fai_at >= m.anchor_at AND i.fai_at < m.anchor_at + INTERVAL 24 HOUR AS interaction_24h,
      i.has_interaction = 1 AND i.fai_cohort = 'fresh' AND s.has_surface = 1
        AND i.fai_at >= s.surface_at AND i.fai_at < m.anchor_at + INTERVAL 24 HOUR AS interaction_after_surface_24h,
      i.has_interaction = 1 AND i.fai_cohort != 'fresh' AS install_cohort_mismatch,
      if(interaction_24h, i.fai_source, 'none') AS first_source
    FROM mature m
    LEFT JOIN surface s ON s.uid = m.uid
    LEFT JOIN interaction i ON i.uid = m.uid
  )
SELECT
  if(grouping(platform) = 1, 'all', platform) AS platform_group,
  count() AS fresh_starters_complete_24h,
  countIf(surface_24h) AS workspace_available_24h,
  round(100.0 * workspace_available_24h / nullIf(fresh_starters_complete_24h, 0), 1) AS workspace_available_pct,
  countIf(interaction_24h) AS first_interaction_24h,
  round(100.0 * first_interaction_24h / nullIf(fresh_starters_complete_24h, 0), 1) AS first_interaction_pct,
  countIf(interaction_24h AND first_source IN ('orca_send', 'native_chat', 'mobile_chat')) AS first_interaction_attributed_24h,
  countIf(interaction_24h AND first_source = 'unattributed_prompt') AS first_interaction_unattributed_24h,
  countIf(interaction_24h AND first_source NOT IN ('orca_send', 'native_chat', 'mobile_chat', 'unattributed_prompt')) AS first_interaction_unknown_source_24h,
  countIf(interaction_after_surface_24h) AS interaction_after_workspace_24h,
  countIf(install_cohort_mismatch) AS install_cohort_mismatch
FROM per_install
GROUP BY ROLLUP(platform)
ORDER BY platform_group
