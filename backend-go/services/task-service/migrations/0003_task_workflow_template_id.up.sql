-- BACKLOG-016 / CR-FLOW-TASK-002: lets AttachWorkflowTemplateAction.tsx's
-- workflow-template choice actually persist. No FK — workflow.templates
-- lives in workflow-service's own database (database-per-service, per
-- specs/backend-go/architecture/05-data-architecture.md), same cross-service
-- reference convention project_id already uses (migrations/0002).
ALTER TABLE task.tasks ADD COLUMN workflow_template_id UUID;
