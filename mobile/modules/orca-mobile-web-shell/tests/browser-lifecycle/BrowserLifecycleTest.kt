package expo.modules.orcamobilewebshell

import android.app.Activity
import android.os.*
import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.util.concurrent.CompletableFuture

private fun message(generation: String, id: Int, endpoint: Messenger? = null, foreground: Boolean = false) =
  Message.obtain().apply {
    arg1 = id; replyTo = endpoint
    data.putString("generation", generation)
    data.putString("result", "{}")
    data.putBoolean("foreground", foreground)
  }

private class Guest(ready: Boolean = true) {
  val owner = BrowserGuestOwner()
  val activity = Activity()
  val open = owner.open(activity, "{}", ReactContext())
  val generation = requireNotNull(activity.launch?.extras?.get("generation") as? String)
  val receiver = requireNotNull(activity.launch?.extras?.get("owner") as? Messenger)
  val endpoint = Messenger(Handler(Looper.getMainLooper()) { true })
  init { if (ready) attach() }
  fun attach() {
    receiver.send(message(generation, -1, endpoint))
    foreground(true)
    receiver.send(message(generation, 0))
  }
  fun foreground(value: Boolean) { receiver.send(message(generation, -2, foreground = value)) }
  fun reopen() = owner.open(activity, "{}", ReactContext())
}

private fun failure(future: CompletableFuture<String>, expected: String): Throwable {
  check(future.isCompletedExceptionally) { "Expected immediate failure: $expected" }
  val cause = runCatching { future.join() }.exceptionOrNull()?.cause
  check(cause?.message == expected) { "Expected $expected, got $cause" }
  return requireNotNull(cause)
}

private fun scenario(name: String, block: () -> Unit) {
  Scheduler.reset()
  HeadlessJsTaskContext.instance.active.clear()
  block()
  println("PASS: $name")
}

fun main() {
  for (transport in listOf(TransactionTooLargeException(), DeadObjectException())) {
    scenario("${transport.javaClass.simpleName}: command failure retains lease without replay") {
      val guest = Guest()
      guest.endpoint.binder.failure = transport
      val command = guest.owner.command(guest.generation, "side-effect")
      check(failure(command, "guest_transport_unavailable").cause === transport)
      check(guest.endpoint.binder.alive)
      failure(guest.reopen(), "guest_process_occupied")
      Scheduler.advance(12000)
      check(guest.endpoint.sends == 1 && guest.activity.launches == 1)
      guest.endpoint.binder.die()
      check(!guest.reopen().isDone && guest.activity.launches == 2)
    }
    scenario("${transport.javaClass.simpleName}: close failure never confirms close") {
      val guest = Guest()
      guest.endpoint.binder.failure = transport
      val close = guest.owner.close(guest.generation)
      failure(close, "guest_transport_unavailable")
      check(guest.endpoint.binder.alive)
      failure(guest.reopen(), "guest_process_occupied")
      guest.owner.destroy()
      Scheduler.advance(15000)
      check(guest.endpoint.sends == 1)
      guest.endpoint.binder.die()
      failure(close, "guest_transport_unavailable")
      check(!guest.reopen().isDone)
    }
  }
  scenario("actual death fails pending command and frees profile") {
    val guest = Guest()
    val command = guest.owner.command(guest.generation, "{}")
    check(!command.isDone)
    guest.endpoint.binder.die()
    failure(command, "guest_process_exited")
    check(HeadlessJsTaskContext.instance.active.isEmpty())
    val reopened = guest.reopen()
    guest.receiver.send(message(guest.generation, 0))
    check(!reopened.isDone)
  }
  scenario("close requires death, rejects duplicate, and finishes task wait") {
    val guest = Guest()
    val token = HeadlessJsTaskContext.instance.last!!.data.values.getValue("taskToken")
    val wait = guest.owner.waitForTaskStop(guest.generation, token)
    val close = guest.owner.close(guest.generation)
    check(wait.join() == "{}" && !close.isDone)
    failure(guest.owner.close(guest.generation), "stale_guest_generation")
    guest.endpoint.binder.die()
    check(close.join() == "{}")
  }
  scenario("unconfirmed close stays occupied after timeout") {
    val guest = Guest()
    val close = guest.owner.close(guest.generation)
    Scheduler.advance(5000)
    failure(close, "guest_close_unconfirmed")
    failure(guest.reopen(), "guest_process_occupied")
  }
  scenario("launch cause survives cleanup and task finishes") {
    val owner = BrowserGuestOwner()
    val activity = Activity().apply { fail = true }
    failure(owner.open(activity, "{}", ReactContext()), "injected_launch_denied")
    check(HeadlessJsTaskContext.instance.active.isEmpty())
    activity.fail = false
    check(!owner.open(activity, "{}", ReactContext()).isDone && activity.launches == 1)
  }
  scenario("teardown immediately settles resume and ignores late foreground") {
    val guest = Guest()
    guest.foreground(false)
    val resume = guest.owner.resume(guest.activity, guest.generation)
    check(!resume.isDone)
    guest.owner.destroy()
    failure(resume, "guest_closed")
    guest.foreground(true)
    check(HeadlessJsTaskContext.instance.active.isEmpty())
    Scheduler.advance(5000)
    failure(resume, "guest_closed")
  }
  scenario("late task token never binds to a replacement task") {
    val guest = Guest()
    val tasks = HeadlessJsTaskContext.instance
    val oldToken = tasks.last!!.data.values.getValue("taskToken")
    guest.foreground(false)
    guest.foreground(true)
    val token = tasks.last!!.data.values.getValue("taskToken")
    check(oldToken != token && guest.owner.waitForTaskStop(guest.generation, oldToken).isDone)
    val wait = guest.owner.waitForTaskStop(guest.generation, token)
    check(!wait.isDone)
    guest.owner.destroy()
    check(wait.isDone)
  }
  scenario("startup timeout retains slot and late endpoint closes until death") {
    val guest = Guest(ready = false)
    Scheduler.advance(15000)
    failure(guest.open, "guest_open_timeout")
    failure(guest.reopen(), "guest_process_occupied")
    guest.attach()
    check(guest.endpoint.sends == 1 && HeadlessJsTaskContext.instance.active.isEmpty())
    guest.endpoint.binder.die()
    check(!guest.reopen().isDone)
  }
  scenario("link failure is unavailable, not confirmed death") {
    val guest = Guest(ready = false)
    guest.endpoint.binder.linkFailure = DeadObjectException()
    guest.attach()
    failure(guest.open, "guest_transport_unavailable")
    failure(guest.reopen(), "guest_process_occupied")
    check(guest.endpoint.binder.alive)
  }
  scenario("fixture terminate send failure cannot report success") {
    val guest = Guest()
    guest.endpoint.binder.failure = TransactionTooLargeException()
    failure(guest.owner.terminateFixture(guest.generation), "guest_transport_unavailable")
    failure(guest.reopen(), "guest_process_occupied")
    check(guest.endpoint.sends == 1)
  }
}
