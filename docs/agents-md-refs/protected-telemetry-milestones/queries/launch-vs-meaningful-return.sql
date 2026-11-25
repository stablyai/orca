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
  last_complete AS (
    SELECT formatDateTime(now() - INTERVAL 1455 MINUTE, '%Y-%m-%d') AS day
  ),
  activity_days AS (
    SELECT
      c.uid AS uid,
      dateDiff('day', toDate(c.cohort_day), toDate(formatDateTime(e.timestamp, '%Y-%m-%d'))) AS day_n,
      countIf(e.event = 'meaningful_activity_day') > 0 AS meaningful,
      countIf(e.event = 'app_opened') > 0 AS launched
    FROM events e
    INNER JOIN cohort c ON c.uid = e.distinct_id
    WHERE e.event IN ('meaningful_activity_day', 'app_opened')
      AND e.timestamp >= toDateTime('2026-11-08 00:00:00')
      AND e.timestamp > c.anchor_at
      AND e.properties.orca_channel IS NOT NULL
    GROUP BY uid, day_n
  ),
  per_install AS (
    SELECT
      c.uid AS uid,
      c.platform AS platform,
      dateDiff('day', toDate(c.cohort_day), toDate((SELECT day FROM last_complete))) AS mature_days,
      countIf(d.day_n = 1 AND d.meaningful) > 0 AS m_d1,
      countIf(d.day_n BETWEEN 1 AND 3 AND d.meaningful) > 0 AS m_d3,
      countIf(d.day_n BETWEEN 1 AND 7 AND d.meaningful) > 0 AS m_d7,
      countIf(d.day_n BETWEEN 8 AND 14 AND d.meaningful) > 0 AS m_w2,
      countIf(d.day_n BETWEEN 24 AND 30 AND d.meaningful) > 0 AS m_d30w,
      countIf(d.day_n = 1 AND d.launched) > 0 AS l_d1,
      countIf(d.day_n BETWEEN 1 AND 3 AND d.launched) > 0 AS l_d3,
      countIf(d.day_n BETWEEN 1 AND 7 AND d.launched) > 0 AS l_d7,
      countIf(d.day_n BETWEEN 8 AND 14 AND d.launched) > 0 AS l_w2,
      countIf(d.day_n BETWEEN 24 AND 30 AND d.launched) > 0 AS l_d30w
    FROM cohort c
    LEFT JOIN activity_days d ON d.uid = c.uid
    GROUP BY c.uid, c.cohort_day, c.platform
  )
SELECT
  platform_group,
  ['D1 (day 1)', 'D3 (days 1-3)', 'D7 (days 1-7)', '2-week (days 8-14)', '30-day (days 24-30)'][wi] AS window_label,
  [1, 3, 7, 14, 30][wi] AS window_end_day,
  countIf(mature_days >= [1, 3, 7, 14, 30][wi]) AS eligible_installs,
  countIf(mature_days >= [1, 3, 7, 14, 30][wi] AND meaningful_flags[wi]) AS meaningful_returned,
  round(100.0 * meaningful_returned / nullIf(eligible_installs, 0), 1) AS meaningful_pct,
  countIf(mature_days >= [1, 3, 7, 14, 30][wi] AND launch_flags[wi]) AS launch_returned,
  round(100.0 * launch_returned / nullIf(eligible_installs, 0), 1) AS launch_pct
FROM (
  SELECT
    arrayJoin([platform, 'all']) AS platform_group,
    arrayJoin([1, 2, 3, 4, 5]) AS wi,
    mature_days,
    [m_d1, m_d3, m_d7, m_w2, m_d30w] AS meaningful_flags,
    [l_d1, l_d3, l_d7, l_w2, l_d30w] AS launch_flags
  FROM per_install
)
GROUP BY platform_group, wi
ORDER BY wi, platform_group
